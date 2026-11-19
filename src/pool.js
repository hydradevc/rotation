import { state } from './store.js';

const BUCKETS = 120;
const WINDOW = 60;
const runtimes = new Map();

export function rt(key) {
  let r = runtimes.get(key.id);
  if (!r) {
    r = {
      rpm: new Float64Array(BUCKETS),
      tpm: new Float64Array(BUCKETS),
      epoch: new Float64Array(BUCKETS).fill(-1),
      inflight: 0,
      fails: 0,
      authFails: 0,
      cooldownUntil: 0,
      lastStatus: 0,
      lastError: '',
      lastUsed: 0,
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

function sumWindow(r, arr, nowSec) {
  let total = 0;
  for (let i = 0; i < BUCKETS; i++) {
    const e = r.epoch[i];
    if (e <= nowSec && e > nowSec - WINDOW) total += arr[i];
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
  markFailure(key, kind, message);
  const base = kind === 'auth' ? 60000 : state.settings.cooldownBaseMs;
  const backoff = Math.min(state.settings.cooldownMaxMs, base * Math.pow(2, Math.min(r.fails - 1, 6)));
  const ms = Math.max(retryAfterMs, backoff, 250);
  r.cooldownUntil = Date.now() + ms;
  r.lastStatus = 0;
  return ms;
}

export function isCoolingDown(key) {
  return rt(key).cooldownUntil > Date.now();
}

function scoreOf(key, r, nowSec) {
  const rpm = sumWindow(r, r.rpm, nowSec);
  const tpm = sumWindow(r, r.tpm, nowSec);
  if (key.rpm && rpm >= key.rpm) return Infinity;
  if (key.tpm && tpm >= key.tpm) return Infinity;
  const load = (r.inflight + 1) / (key.weight || 1);
  const rpmPressure = key.rpm ? rpm / key.rpm : 0;
  const tpmPressure = key.tpm ? tpm / key.tpm : 0;
  return load * (1 + rpmPressure * 0.85 + tpmPressure * 0.85) + r.fails * 2;
}

export function pickKey({ provider = null, nativeFormat = null, exclude = null } = {}) {
  const now = Date.now();
  const nowSec = Math.floor(now / 1000);
  const candidates = [];
  for (const key of state.keys) {
    if (key.status !== 'active') continue;
    if (exclude && exclude.has(key.id)) continue;
    if (provider && key.provider !== provider) continue;
    const r = rt(key);
    if (r.cooldownUntil > now) continue;
    candidates.push(key);
  }
  if (!candidates.length) return null;

  let pool = candidates;
  if (nativeFormat) {
    const native = candidates.filter((k) => k.provider === nativeFormat);
    if (native.length) pool = native;
  }

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

export function poolSnapshot() {
  const now = Date.now();
  const nowSec = Math.floor(now / 1000);
  let rpm = 0;
  let tpm = 0;
  let inflight = 0;
  let healthy = 0;
  const keys = state.keys.map((key) => {
    const r = rt(key);
    const w = { rpm: sumWindow(r, r.rpm, nowSec), tpm: sumWindow(r, r.tpm, nowSec) };
    rpm += w.rpm;
    tpm += w.tpm;
    inflight += r.inflight;
    const cooling = r.cooldownUntil > now;
    if (key.status === 'active' && !cooling) healthy += 1;
    let latSum = 0;
    for (let i = 0; i < r.latLen; i++) latSum += r.lat[i];
    return {
      id: key.id,
      label: key.label,
      provider: key.provider,
      baseUrl: key.baseUrl,
      masked: key.key.length > 10 ? key.key.slice(0, 6) + '…' + key.key.slice(-4) : key.key,
      status: key.status,
      weight: key.weight,
      rpmLimit: key.rpm,
      tpmLimit: key.tpm,
      rpm: Math.round(w.rpm),
      tpm: Math.round(w.tpm),
      inflight: r.inflight,
      coolingMs: cooling ? r.cooldownUntil - now : 0,
      avgLatency: r.latLen ? Math.round(latSum / r.latLen) : 0,
      fails: r.fails,
      lastError: key.lastError || '',
      lastUsed: r.lastUsed || key.lastUsed || 0,
      totals: key.totals
    };
  });
  return {
    keys,
    summary: {
      keys: state.keys.length,
      healthy,
      rpm: Math.round(rpm),
      tpm: Math.round(tpm),
      inflight,
      capacityRpm: state.keys.reduce((a, k) => a + (k.status === 'active' ? k.rpm : 0), 0),
      capacityTpm: state.keys.reduce((a, k) => a + (k.status === 'active' ? k.tpm : 0), 0)
    }
  };
}