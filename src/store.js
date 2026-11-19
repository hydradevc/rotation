import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

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
  version: 1,
  settings: { ...DEFAULT_SETTINGS },
  keys: [],
  clients: [],
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
  return {
    id: newId('k'),
    label: String(input.label || '').trim() || maskKey(String(input.key || '')),
    provider,
    baseUrl: String(
      input.baseUrl || (provider === 'anthropic' ? 'https://api.anthropic.com' : 'https://api.openai.com/v1')
    ).replace(/\/+$/, ''),
    key: String(input.key || '').trim(),
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

export function flush() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = STATE_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, STATE_FILE);
  } catch (err) {
    console.error('[store] write failed:', err.message);
  }
}

export function load() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    if (!fs.existsSync(STATE_FILE)) return false;
    const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    state.settings = { ...DEFAULT_SETTINGS, ...(raw.settings || {}) };
    state.settings.modelRoutes = { ...DEFAULT_SETTINGS.modelRoutes, ...(raw.settings?.modelRoutes || {}) };
    state.keys = Array.isArray(raw.keys) ? raw.keys : [];
    state.clients = Array.isArray(raw.clients) ? raw.clients : [];
    state.totals = { ...state.totals, ...(raw.totals || {}) };
    for (const k of state.keys) {
      k.totals = k.totals || { req: 0, ok: 0, fail: 0, tin: 0, tout: 0 };
      k.status = k.status || 'active';
    }
    for (const c of state.clients) {
      c.totals = c.totals || { req: 0, ok: 0, fail: 0, tin: 0, tout: 0 };
      c.day = c.day || { date: '', tokens: 0 };
      c.status = c.status || 'active';
    }
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