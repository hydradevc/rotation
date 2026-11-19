import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { initMasterKey, seal, openSafe } from './crypto.js';

const DATA_DIR = process.env.HYDRA_DATA || path.resolve(process.cwd(), 'data');
const STATE_FILE = path.join(DATA_DIR, 'state.json');

const DEFAULT_SETTINGS = {
  adminPasswordHash: null,
  defaultLang: 'en',
  maxAttempts: 8,
  deadlineMs: 120000,
  upstreamTimeoutMs: 180000,
  streamIdleMs: 240000,
  cooldownBaseMs: 1500,
  cooldownMaxMs: 60000,
  sampleSize: 5,
  autoDisableAfterAuthFails: 5,
  policy: 'smart',
  queueWaitMs: 5000,
  circuitThreshold: 4,
  circuitCooldownMs: 120000,
  models: [],
  metricsPublic: false,
  cors: false,
  corsOrigin: '*',
  webhookUrl: '',
  webhookEvents: ['key-down', 'pool-exhausted'],
  retryStatuses: [408, 409, 425, 429, 500, 502, 503, 504, 529],
  modelRoutes: {
    claude: 'anthropic',
    'gpt-': 'openai',
    o1: 'openai',
    o3: 'openai',
    o4: 'openai',
    'text-embedding': 'openai'
  },
  aliases: {}
};

export const state = {
  version: 2,
  settings: { ...DEFAULT_SETTINGS },
  keys: [],
  clients: [],
  meta: { sealed: false, unreadableKeys: 0 },
  totals: { req: 0, ok: 0, fail: 0, tin: 0, tout: 0, startedAt: Date.now() }
};

export function newId(prefix) {
  return prefix + '_' + crypto.randomBytes(6).toString('hex');
}

export function newAccessKey() {
  return 'hydra_sk_' + crypto.randomBytes(24).toString('hex');
}

export function maskKey(key = '') {
  if (key.length <= 10) return key.slice(0, 3) + '…';
  return key.slice(0, 6) + '…' + key.slice(-4);
}

export function normalizeKey(input) {
  const provider = input.provider === 'anthropic' ? 'anthropic' : 'openai';
  const rawKey = String(input.key || '').trim();
  if (!rawKey) return null;
  return {
    id: newId('k'),
    label: String(input.label || '').trim() || maskKey(rawKey),
    provider,
    baseUrl: String(
      input.baseUrl || (provider === 'anthropic' ? 'https://api.anthropic.com' : 'https://api.openai.com/v1')
    ).replace(/\/+$/, ''),
    key: rawKey,
    weight: clampNum(input.weight, 1, 1, 100),
    rpm: clampNum(input.rpm, 60, 1, 1e6),
    tpm: clampNum(input.tpm, 0, 0, 1e9),
    model: input.model ? String(input.model) : '',
    status: input.status === 'disabled' ? 'disabled' : 'active',
    createdAt: Date.now(),
    lastUsed: 0,
    lastError: '',
    totals: { req: 0, ok: 0, fail: 0, tin: 0, tout: 0 }
  };
}

export function normalizeClient(input) {
  return {
    id: newId('c'),
    name: String(input.name || 'default').trim().slice(0, 60) || 'default',
    key: input.key || newAccessKey(),
    rpm: clampNum(input.rpm, 600, 0, 1e6),
    dailyTokens: clampNum(input.dailyTokens, 0, 0, 1e12),
    models: Array.isArray(input.models) ? input.models.map(String).filter(Boolean) : [],
    status: input.status === 'disabled' ? 'disabled' : 'active',
    createdAt: Date.now(),
    lastUsed: 0,
    day: { date: '', tokens: 0 },
    totals: { req: 0, ok: 0, fail: 0, tin: 0, tout: 0 }
  };
}

function clampNum(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, 32).toString('hex');
  return 'scrypt$' + salt + '$' + hash;
}

export function verifyPassword(password, stored) {
  if (!stored) return false;
  const parts = String(stored).split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const expected = Buffer.from(parts[2], 'hex');
  const actual = crypto.scryptSync(String(password), parts[1], expected.length);
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

export function generatePassword() {
  return crypto.randomBytes(9).toString('base64url');
}

let saveTimer = null;

export function save() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    flush();
  }, 1200);
  saveTimer.unref?.();
}

function serialise() {
  return JSON.stringify(
    {
      ...state,
      version: 2,
      meta: { ...state.meta, sealed: true },
      keys: state.keys.map((key) => ({ ...key, key: seal(key.key) })),
      clients: state.clients.map((client) => ({ ...client, key: seal(client.key) }))
    },
    null,
    2
  );
}

export function flush() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = STATE_FILE + '.tmp';
    const fd = fs.openSync(tmp, 'w', 0o600);
    try {
      fs.writeFileSync(fd, serialise());
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    if (fs.existsSync(STATE_FILE)) {
      try {
        fs.renameSync(STATE_FILE, STATE_FILE + '.bak');
      } catch {
        /* first write or locked file */
      }
    }
    fs.renameSync(tmp, STATE_FILE);
    try {
      fs.chmodSync(STATE_FILE, 0o600);
    } catch {
      /* best effort */
    }
    state.meta.sealed = true;
  } catch (err) {
    console.error('[store] write failed:', err.message);
  }
}

export function load() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    initMasterKey(DATA_DIR);

    const backup = STATE_FILE + '.bak';
    let raw = null;
    if (fs.existsSync(STATE_FILE)) {
      try {
        raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      } catch (err) {
        console.error('[store] state.json is unreadable:', err.message);
      }
    }
    if (!raw && fs.existsSync(backup)) {
      try {
        raw = JSON.parse(fs.readFileSync(backup, 'utf8'));
        console.error('[store] recovered from state.json.bak');
      } catch (err) {
        console.error('[store] backup is unreadable too:', err.message);
      }
    }
    if (!raw) return false;
    state.settings = { ...DEFAULT_SETTINGS, ...(raw.settings || {}) };
    state.settings.modelRoutes = { ...DEFAULT_SETTINGS.modelRoutes, ...(raw.settings?.modelRoutes || {}) };
    state.keys = Array.isArray(raw.keys) ? raw.keys : [];
    state.clients = Array.isArray(raw.clients) ? raw.clients : [];
    state.totals = { ...state.totals, ...(raw.totals || {}) };
    state.meta = { sealed: true, unreadableKeys: 0 };

    for (const key of state.keys) {
      key.totals = key.totals || { req: 0, ok: 0, fail: 0, tin: 0, tout: 0 };
      key.status = key.status || 'active';
      const plain = openSafe(key.key);
      if (plain === null) {
        state.meta.unreadableKeys += 1;
        key.status = 'disabled';
        key.lastError = 'cannot decrypt: master key mismatch';
        key.key = '';
      } else {
        key.key = plain;
      }
    }

    for (const client of state.clients) {
      client.totals = client.totals || { req: 0, ok: 0, fail: 0, tin: 0, tout: 0 };
      client.day = client.day || { date: '', tokens: 0 };
      client.status = client.status || 'active';
      const plain = openSafe(client.key);
      if (plain === null) {
        state.meta.unreadableKeys += 1;
        client.status = 'disabled';
        client.key = '';
      } else {
        client.key = plain;
      }
    }

    save();
    return true;
  } catch (err) {
    console.error('[store] load failed:', err.message);
    return false;
  }
}

const ROLLING = 300;
export const metrics = {
  epoch: new Float64Array(ROLLING).fill(-1),
  req: new Float64Array(ROLLING),
  tokens: new Float64Array(ROLLING),
  lastSecond: 0,
  lastReq: 0,
  lastTokens: 0
};

export function markSecond(nowMs = Date.now()) {
  const sec = Math.floor(nowMs / 1000);
  if (sec !== metrics.lastSecond) {
    metrics.lastReq = 0;
    metrics.lastTokens = 0;
    metrics.lastSecond = sec;
  }
  return sec;
}

export function tickRequests(n = 1, tokens = 0, nowMs = Date.now()) {
  const sec = markSecond(nowMs);
  const i = sec % ROLLING;
  if (metrics.epoch[i] !== sec) {
    metrics.epoch[i] = sec;
    metrics.req[i] = 0;
    metrics.tokens[i] = 0;
  }
  metrics.req[i] += n;
  metrics.tokens[i] += tokens;
  metrics.lastReq += n;
  metrics.lastTokens += tokens;
}

export function series(nowMs = Date.now()) {
  const sec = Math.floor(nowMs / 1000);
  const req = new Array(ROLLING);
  const tokens = new Array(ROLLING);
  for (let offset = 0; offset < ROLLING; offset++) {
    const s = sec - (ROLLING - 1) + offset;
    const i = ((s % ROLLING) + ROLLING) % ROLLING;
    const live = metrics.epoch[i] === s;
    req[offset] = live ? metrics.req[i] : 0;
    tokens[offset] = live ? metrics.tokens[i] : 0;
  }
  return { req, tokens };
}

const LOG_LIMIT = 300;
export const logRing = [];

export function pushLog(entry) {
  logRing.unshift(entry);
  if (logRing.length > LOG_LIMIT) logRing.length = LOG_LIMIT;
}