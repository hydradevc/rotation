import { state } from './store.js';

const BUCKETS = 120;
const WINDOW = 60;
const runtimes = new Map();
let rrCursor = 0;

export function rt(key) {
  let r = runtimes.get(key.id);
  if (!r) {
    r = {
      rpm: new Float64Array(BUCKETS),
      tpm: new Float64Array(BUCKETS),
      epoch: new Float64Array(BUCKETS).fill(-1),
      inflight: 0,
      fails: 0,
      successes: 0,
      authFails: 0,
      cooldownUntil: 0,
      lastStatus: 0,
      lastError: '',
      lastUsed: 0,
      lastProbeAt: 0,
      lat: new Float64Array(64),
      latIdx: 0,
      latLen: 0
    };
    runtimes.set(key.id, r);
  }
  return r;
}

export function dropRuntime(id) {
  runtimes.delete(id);
}

function sumWindow(r, arr, nowSec, slack = 0) {
  let total = 0;
  const from = nowSec - WINDOW - slack;
  for (let i = 0; i < BUCKETS; i++) {
    const e = r.epoch[i];
    if (e <= nowSec && e > from) total += arr[i];
  }
  return total;
}

function addWindow(r, nowSec, reqDelta, tokDelta) {
  const i = ((nowSec % BUCKETS) + BUCKETS) % BUCKETS;
  if (r.epoch[i] !== nowSec) {
    r.epoch[i] = nowSec;
    r.rpm[i] = 0;
    r.tpm[i] = 0;
  }
  r.rpm[i] += reqDelta;
  r.tpm[i] += tokDelta;
}

export function windowOf(key, nowMs = Date.now()) {
  const r = rt(key);
  const nowSec = Math.floor(nowMs / 1000);
  return { rpm: sumWindow(r, r.rpm, nowSec), tpm: sumWindow(r, r.tpm, nowSec) };
}

export function reserve(key, estTokens = 0) {
  const r = rt(key);
  r.inflight += 1;
  addWindow(r, Math.floor(Date.now() / 1000), 1, Math.max(0, estTokens));
  r.lastUsed = Date.now();
  key.lastUsed = r.lastUsed;
}

export function settle(key, { tokenDelta = 0 } = {}) {
  const r = rt(key);
  r.inflight = Math.max(0, r.inflight - 1);
  if (tokenDelta !== 0) addWindow(r, Math.floor(Date.now() / 1000), 0, tokenDelta);
}

export function recordLatency(key, ms) {
  const r = rt(key);
  r.lat[r.latIdx] = ms;
  r.latIdx = (r.latIdx + 1) % r.lat.length;
  if (r.latLen < r.lat.length) r.latLen += 1;
}

export function markSuccess(key, status = 200) {
  const r = rt(key);
  r.fails = 0;
  r.authFails = 0;
  r.successes += 1;
  r.lastStatus = status;
  r.lastError = '';
  key.lastError = '';
}

export function markFailure(key, kind, message = '') {
  const r = rt(key);
  r.fails += 1;
  r.lastError = String(message).slice(0, 200);
  key.lastError = r.lastError;
  if (kind === 'auth') r.authFails += 1;
  return r.fails;
}

export function penalize(key, { retryAfterMs = 0, kind = 'rate', message = '' } = {}) {
  const r = rt(key);
  const fails = markFailure(key, kind, message);
  const breaker = fails >= (state.settings.circuitThreshold || 4);
  const base = kind === 'auth' ? 60000 : state.settings.cooldownBaseMs;
  const ceiling = breaker
    ? Math.max(state.settings.circuitCooldownMs || 120000, state.settings.cooldownMaxMs)
    : state.settings.cooldownMaxMs;
  const backoff = Math.min(ceiling, base * Math.pow(2, Math.min(fails - 1, 6)));
  const ms = Math.max(retryAfterMs, backoff, 250);
  r.cooldownUntil = Date.now() + ms;
  r.lastStatus = 0;
  return ms;
}

export function isCoolingDown(key) {
  return rt(key).cooldownUntil > Date.now();
}

export function clearCooldown(key) {
  const r = rt(key);
  r.cooldownUntil = 0;
  r.fails = 0;
  r.authFails = 0;
}

function scoreOf(key, r, nowSec) {
  const rpm = sumWindow(r, r.rpm, nowSec, 2);
  const tpm = sumWindow(r, r.tpm, nowSec, 2);
  if (key.rpm && rpm >= key.rpm) return Infinity;
  if (key.tpm && tpm >= key.tpm) return Infinity;
  const load = (r.inflight + 1) / (key.weight || 1);
  const rpmPressure = key.rpm ? rpm / key.rpm : 0;
  const tpmPressure = key.tpm ? tpm / key.tpm : 0;
  return load * (1 + rpmPressure * 3 + tpmPressure * 3) + r.fails * 2;
}

function eligible({ provider = null, nativeFormat = null, exclude = null, now = Date.now() }) {
  const list = [];
  for (const key of state.keys) {
    if (key.status !== 'active') continue;
    if (exclude && exclude.has(key.id)) continue;
    if (provider && key.provider !== provider) continue;
    if (rt(key).cooldownUntil > now) continue;
    list.push(key);
  }
  if (!list.length) return list;
  if (nativeFormat) {
    const native = list.filter((k) => k.provider === nativeFormat);
    if (native.length) return native;
  }
  return list;
}

function hasCapacity(key, nowSec) {
  const r = rt(key);
  const rpm = sumWindow(r, r.rpm, nowSec, 2);
  const tpm = sumWindow(r, r.tpm, nowSec, 2);
  if (key.rpm && rpm >= key.rpm) return false;
  if (key.tpm && tpm >= key.tpm) return false;
  return true;
}

let randomBag = [];

function pickRandomBag(pool) {
  randomBag = randomBag.filter((id) => pool.some((k) => k.id === id));
  if (!randomBag.length) {
    randomBag = pool.map((k) => k.id);
    for (let i = randomBag.length - 1; i > 0; i--) {
      const j = (Math.random() * (i + 1)) | 0;
      [randomBag[i], randomBag[j]] = [randomBag[j], randomBag[i]];
    }
  }
  const id = randomBag.pop();
  return pool.find((k) => k.id === id) || pool[0];
}

function pickSmart(pool, nowSec) {
  const sampleSize = Math.min(pool.length, Math.max(1, state.settings.sampleSize || 5));
  if (pool.length <= sampleSize) {
    let best = null;
    let bestScore = Infinity;
    for (const key of pool) {
      const s = scoreOf(key, rt(key), nowSec);
      if (s < bestScore) {
        bestScore = s;
        best = key;
      }
    }
    return best;
  }
  let best = null;
  let bestScore = Infinity;
  const start = (Math.random() * pool.length) | 0;
  const step = 1 + ((Math.random() * (pool.length - 1)) | 0);
  for (let n = 0; n < sampleSize; n++) {
    const key = pool[(start + n * step) % pool.length];
    const s = scoreOf(key, rt(key), nowSec);
    if (s < bestScore) {
      bestScore = s;
      best = key;
    }
  }
  return best;
}

function pickWeighted(pool) {
  const weights = pool.map((k) => Math.max(1, k.weight || 1) - rt(k).inflight * 0.5);
  const total = weights.reduce((a, b) => a + Math.max(0.1, b), 0);
  let roll = Math.random() * total;
  for (let i = 0; i < pool.length; i++) {
    roll -= Math.max(0.1, weights[i]);
    if (roll <= 0) return pool[i];
  }
  return pool[pool.length - 1];
}

export function pickKey({ provider = null, nativeFormat = null, exclude = null, allowOverflow = false } = {}) {
  const now = Date.now();
  const nowSec = Math.floor(now / 1000);
  const pool = eligible({ provider, nativeFormat, exclude, now });
  if (!pool.length) return null;

  const usable = pool.filter((k) => hasCapacity(k, nowSec));
  if (!usable.length) {
    if (!allowOverflow) return null;
    let best = null;
    let bestUsed = Infinity;
    for (const key of pool) {
      const used = sumWindow(rt(key), rt(key).rpm, nowSec, 2) / Math.max(1, key.rpm || 1);
      if (used < bestUsed) {
        bestUsed = used;
        best = key;
      }
    }
    return best;
  }

  const policy = state.settings.policy || 'smart';
  if (policy === 'round-robin') {
    rrCursor = (rrCursor + 1) % usable.length;
    return usable[rrCursor];
  }
  if (policy === 'random') {
    return pickRandomBag(usable);
  }
  if (policy === 'weighted') {
    return pickWeighted(usable);
  }
  return pickSmart(usable, nowSec);
}

export function msUntilSlot({ provider = null } = {}) {
  const now = Date.now();
  const nowSec = Math.floor(now / 1000);
  let soonest = Infinity;
  let blocked = false;
  for (const key of state.keys) {
    if (key.status !== 'active') continue;
    if (provider && key.provider !== provider) continue;
    const r = rt(key);
    if (r.cooldownUntil > now) {
      soonest = Math.min(soonest, r.cooldownUntil - now);
      continue;
    }
    if (hasCapacity(key, nowSec)) return 0;
    blocked = true;
  }
  if (blocked) soonest = Math.min(soonest, 1000);
  return Number.isFinite(soonest) ? soonest : null;
}

export function poolSnapshot() {
  const now = Date.now();
  const nowSec = Math.floor(now / 1000);
  let rpm = 0;
  let tpm = 0;
  let inflight = 0;
  let healthy = 0;
  let cooling = 0;
  const keys = state.keys.map((key) => {
    const r = rt(key);
    const w = { rpm: sumWindow(r, r.rpm, nowSec), tpm: sumWindow(r, r.tpm, nowSec) };
    rpm += w.rpm;
    tpm += w.tpm;
    inflight += r.inflight;
    const isCooling = r.cooldownUntil > now;
    if (isCooling) cooling += 1;
    if (key.status === 'active' && !isCooling) healthy += 1;
    let latSum = 0;
    for (let i = 0; i < r.latLen; i++) latSum += r.lat[i];
    return {
      id: key.id,
      label: key.label,
      provider: key.provider,
      baseUrl: key.baseUrl,
      model: key.model || '',
      masked: key.key.length > 10 ? key.key.slice(0, 6) + '…' + key.key.slice(-4) : key.key,
      status: key.status,
      weight: key.weight,
      rpmLimit: key.rpm,
      tpmLimit: key.tpm,
      rpm: Math.round(w.rpm),
      tpm: Math.round(w.tpm),
      inflight: r.inflight,
      coolingMs: isCooling ? r.cooldownUntil - now : 0,
      avgLatency: r.latLen ? Math.round(latSum / r.latLen) : 0,
      fails: r.fails,
      authFails: r.authFails,
      lastStatus: r.lastStatus,
      lastError: key.lastError || '',
      lastUsed: r.lastUsed || key.lastUsed || 0,
      lastProbeAt: r.lastProbeAt || 0,
      createdAt: key.createdAt,
      totals: key.totals
    };
  });
  return {
    keys,
    summary: {
      keys: state.keys.length,
      healthy,
      cooling,
      rpm: Math.round(rpm),
      tpm: Math.round(tpm),
      inflight,
      capacityRpm: state.keys.reduce((a, k) => a + (k.status === 'active' ? k.rpm : 0), 0),
      capacityTpm: state.keys.reduce((a, k) => a + (k.status === 'active' ? k.tpm : 0), 0),
      byProvider: state.keys.reduce((acc, k) => {
        if (k.status !== 'active') return acc;
        acc[k.provider] = (acc[k.provider] || 0) + 1;
        return acc;
      }, {})
    }
  };
}