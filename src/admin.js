import crypto from 'node:crypto';
import {
  state,
  save,
  flush,
  logRing,
  series,
  hashPassword,
  verifyPassword,
  normalizeKey,
  normalizeClient,
  newAccessKey
} from './store.js';
import { poolSnapshot, dropRuntime, rt } from './pool.js';

const SESSION_TTL = 12 * 60 * 60 * 1000;
const sessions = new Map();
const loginAttempts = new Map();

function issueSession(req, res) {
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, { expires: Date.now() + SESSION_TTL });
  res.setHeader(
    'set-cookie',
    `hydra_sid=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL / 1000}`
  );
  return token;
}

function cookieToken(req) {
  const raw = req.headers.cookie || '';
  const match = /(?:^|;\s*)hydra_sid=([a-f0-9]{64})/.exec(raw);
  return match ? match[1] : '';
}

function authed(req) {
  const token = cookieToken(req);
  if (!token) return false;
  const session = sessions.get(token);
  if (!session) return false;
  if (session.expires < Date.now()) {
    sessions.delete(token);
    return false;
  }
  return true;
}

function sendJson(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload));
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': body.length,
    'cache-control': 'no-store'
  });
  res.end(body);
}

function parseCookies(req) {
  return req.headers.cookie || '';
}

function readJson(body) {
  try {
    return JSON.parse(body.toString('utf8') || '{}');
  } catch {
    return null;
  }
}

export function authState(req) {
  return {
    authed: authed(req),
    defaultLang: state.settings.defaultLang || 'en'
  };
}

export function hasPassword() {
  return Boolean(state.settings.adminPasswordHash);
}

export function ensurePassword(log) {
  if (state.settings.adminPasswordHash) return null;
  const envPassword = process.env.HYDRA_ADMIN_PASSWORD;
  const password = envPassword || crypto.randomBytes(9).toString('base64url');
  state.settings.adminPasswordHash = hashPassword(password);
  flush();
  if (!envPassword) log(password);
  return password;
}

export function ensureDefaultClient() {
  if (state.clients.length) return null;
  const client = normalizeClient({ name: 'default', rpm: 0, dailyTokens: 0 });
  state.clients.push(client);
  flush();
  return client;
}

function parseBulk(text, defaults = {}) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return [];
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed);
      const list = Array.isArray(parsed) ? parsed : parsed.keys;
      if (Array.isArray(list)) {
        return list
          .map((item) =>
            typeof item === 'string'
              ? parseBulkLine(item, defaults)
              : normalizeKey({
                  label: item.label || item.name,
                  key: item.key || item.apiKey || item.token,
                  baseUrl: item.baseUrl || item.base_url,
                  provider: item.provider,
                  weight: item.weight,
                  rpm: item.rpm,
                  tpm: item.tpm
                })
          )
          .filter(Boolean);
      }
    } catch {
      return [];
    }
  }
  return trimmed
    .split(/\r?\n/)
    .map((line) => parseBulkLine(line, defaults))
    .filter(Boolean);
}

function looksLikeKey(value) {
  return /^[A-Za-z0-9_\-:.]{16,}$/.test(value) && /[0-9]/.test(value);
}

function parseBulkLine(line, defaults) {
  const clean = line.trim();
  if (!clean || clean.startsWith('#') || clean.startsWith('//')) return null;
  const parts = clean.split('|').map((s) => s.trim()).filter(Boolean);
  let key = '';
  let label = '';
  let baseUrl = defaults.baseUrl || '';
  let provider = defaults.provider || '';

  for (const part of parts) {
    if (/^https?:\/\//i.test(part)) {
      baseUrl = part;
    } else if (part === 'openai' || part === 'anthropic') {
      provider = part;
    } else if (!key && looksLikeKey(part)) {
      key = part;
    } else if (!label) {
      label = part;
    } else if (!key) {
      key = part;
    }
  }
  if (!key && parts.length === 1) key = parts[0];
  if (!key) return null;
  if (!provider) provider = key.startsWith('sk-ant-') ? 'anthropic' : 'openai';
  return normalizeKey({ key, label, baseUrl, provider, rpm: 60, tpm: 0 });
}

async function probeKey(key) {
  const started = Date.now();
  const url =
    key.provider === 'anthropic'
      ? key.baseUrl.replace(/\/+$/, '') + '/v1/models'
      : key.baseUrl.replace(/\/+$/, '').replace(/\/v1$/, '') + '/v1/models';
  const headers = { accept: 'application/json' };
  if (key.provider === 'anthropic') {
    headers['x-api-key'] = key.key;
    headers['anthropic-version'] = '2023-06-01';
  } else {
    headers.authorization = 'Bearer ' + key.key;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch(url, { headers, signal: controller.signal });
    const ms = Date.now() - started;
    let message = '';
    if (!res.ok) message = (await res.text().catch(() => '')).slice(0, 200);
    return { ok: res.ok, status: res.status, ms, message };
  } catch (err) {
    return { ok: false, status: 0, ms: Date.now() - started, message: err.message };
  } finally {
    clearTimeout(timer);
  }
}

function publicState() {
  const pool = poolSnapshot();
  const settings = { ...state.settings };
  delete settings.adminPasswordHash;
  return {
    keys: pool.keys.map((k) => {
      const source = state.keys.find((s) => s.id === k.id);
      return { ...k, model: source?.model || '' };
    }),
    summary: pool.summary,
    clients: state.clients.map((c) => ({
      id: c.id,
      name: c.name,
      masked: c.key.slice(0, 12) + '…' + c.key.slice(-6),
      key: c.key,
      rpm: c.rpm,
      dailyTokens: c.dailyTokens,
      models: c.models,
      status: c.status,
      createdAt: c.createdAt,
      lastUsed: c.lastUsed,
      day: c.day,
      totals: c.totals
    })),
    totals: state.totals,
    settings,
    series: series(),
    logs: logRing.slice(0, 80),
    uptime: Math.round((Date.now() - state.totals.startedAt) / 1000)
  };
}

export async function handleAdmin(req, res, url, body) {
  const path = url.pathname;
  const method = req.method;

  if (path === '/admin/api/session' && method === 'GET') {
    sendJson(res, 200, authState(req));
    return true;
  }

  if (path === '/admin/api/login' && method === 'POST') {
    const ip = req.socket.remoteAddress || 'unknown';
    const now = Date.now();
    const bucket = loginAttempts.get(ip) || { count: 0, reset: now + 60000 };
    if (bucket.reset < now) {
      bucket.count = 0;
      bucket.reset = now + 60000;
    }
    if (bucket.count >= 10) {
      sendJson(res, 429, { error: 'too many attempts, wait a minute' });
      return true;
    }
    bucket.count += 1;
    loginAttempts.set(ip, bucket);

    const payload = readJson(body);
    if (!payload || !verifyPassword(payload.password || '', state.settings.adminPasswordHash)) {
      sendJson(res, 401, { error: 'invalid password' });
      return true;
    }
    loginAttempts.delete(ip);
    issueSession(req, res);
    sendJson(res, 200, { ok: true });
    return true;
  }

  if (path === '/admin/api/logout' && method === 'POST') {
    const token = cookieToken(req);
    if (token) sessions.delete(token);
    res.setHeader('set-cookie', 'hydra_sid=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
    sendJson(res, 200, { ok: true });
    return true;
  }

  if (!authed(req)) {
    sendJson(res, 401, { error: 'unauthorized', cookies: Boolean(parseCookies(req)) });
    return true;
  }

  if (path === '/admin/api/state' && method === 'GET') {
    sendJson(res, 200, publicState());
    return true;
  }

  if (path === '/admin/api/keys/bulk' && method === 'POST') {
    const payload = readJson(body) || {};
    const created = parseBulk(payload.text, {
      provider: payload.provider,
      baseUrl: payload.baseUrl
    });
    if (!created.length) {
      sendJson(res, 400, { error: 'no keys parsed' });
      return true;
    }
    state.keys.push(...created);
    save();
    sendJson(res, 200, { ok: true, created: created.length });
    return true;
  }

  const keyMatch = /^\/admin\/api\/keys\/([\w-]+)(\/probe)?$/.exec(path);
  if (keyMatch) {
    const key = state.keys.find((k) => k.id === keyMatch[1]);
    if (!key) {
      sendJson(res, 404, { error: 'key not found' });
      return true;
    }
    if (keyMatch[2] === '/probe' && method === 'POST') {
      const result = await probeKey(key);
      key.lastError = result.ok ? '' : result.message || `HTTP ${result.status}`;
      if (result.ok) {
        key.status = 'active';
        const r = rt(key);
        r.cooldownUntil = 0;
        r.fails = 0;
        r.authFails = 0;
      }
      save();
      sendJson(res, 200, result);
      return true;
    }
    if (method === 'PATCH') {
      const payload = readJson(body) || {};
      for (const field of ['label', 'baseUrl', 'weight', 'rpm', 'tpm', 'status', 'model']) {
        if (payload[field] !== undefined) {
          if (field === 'weight' || field === 'rpm' || field === 'tpm') key[field] = Math.max(0, Number(payload[field]) || 0);
          else key[field] = String(payload[field]);
        }
      }
      if (payload.key) key.key = String(payload.key);
      if (key.status !== 'disabled') {
        const r = rt(key);
        r.cooldownUntil = 0;
      }
      save();
      sendJson(res, 200, { ok: true });
      return true;
    }
    if (method === 'DELETE') {
      state.keys = state.keys.filter((k) => k.id !== key.id);
      dropRuntime(key.id);
      save();
      sendJson(res, 200, { ok: true });
      return true;
    }
  }

  if (path === '/admin/api/keys' && method === 'DELETE') {
    state.keys = [];
    save();
    sendJson(res, 200, { ok: true });
    return true;
  }

  if (path === '/admin/api/clients' && method === 'POST') {
    const payload = readJson(body) || {};
    const client = normalizeClient({
      name: payload.name,
      rpm: payload.rpm,
      dailyTokens: payload.dailyTokens,
      models: payload.models
    });
    state.clients.push(client);
    save();
    sendJson(res, 200, { ok: true, client });
    return true;
  }

  const clientMatch = /^\/admin\/api\/clients\/([\w-]+)$/.exec(path);
  if (clientMatch) {
    const client = state.clients.find((c) => c.id === clientMatch[1]);
    if (!client) {
      sendJson(res, 404, { error: 'client not found' });
      return true;
    }
    if (method === 'PATCH') {
      const payload = readJson(body) || {};
      if (payload.name !== undefined) client.name = String(payload.name).slice(0, 60);
      if (payload.rpm !== undefined) client.rpm = Math.max(0, Number(payload.rpm) || 0);
      if (payload.dailyTokens !== undefined) client.dailyTokens = Math.max(0, Number(payload.dailyTokens) || 0);
      if (payload.models !== undefined) {
        client.models = Array.isArray(payload.models)
          ? payload.models
          : String(payload.models)
              .split(/[\s,]+/)
              .filter(Boolean);
      }
      if (payload.status !== undefined) client.status = payload.status === 'disabled' ? 'disabled' : 'active';
      if (payload.rotate) client.key = newAccessKey();
      save();
      sendJson(res, 200, { ok: true, key: client.key });
      return true;
    }
    if (method === 'DELETE') {
      state.clients = state.clients.filter((c) => c.id !== client.id);
      save();
      sendJson(res, 200, { ok: true });
      return true;
    }
  }

  if (path === '/admin/api/settings' && method === 'POST') {
    const payload = readJson(body) || {};
    const s = state.settings;
    const numeric = [
      'maxAttempts',
      'deadlineMs',
      'upstreamTimeoutMs',
      'streamIdleMs',
      'cooldownBaseMs',
      'cooldownMaxMs',
      'sampleSize'
    ];
    for (const field of numeric) {
      if (payload[field] !== undefined) {
        const n = Number(payload[field]);
        if (Number.isFinite(n) && n >= 0) s[field] = Math.round(n);
      }
    }
    if (payload.defaultLang === 'en' || payload.defaultLang === 'ru') s.defaultLang = payload.defaultLang;
    if (payload.modelRoutes && typeof payload.modelRoutes === 'object') {
      const routes = {};
      for (const [prefix, provider] of Object.entries(payload.modelRoutes)) {
        if (!prefix) continue;
        routes[prefix] = provider === 'anthropic' ? 'anthropic' : 'openai';
      }
      s.modelRoutes = routes;
    }
    if (payload.aliases && typeof payload.aliases === 'object') {
      const aliases = {};
      for (const [alias, target] of Object.entries(payload.aliases)) {
        if (alias && target) aliases[alias] = String(target);
      }
      s.aliases = aliases;
    }
    if (Array.isArray(payload.models)) s.models = payload.models.map(String).filter(Boolean);
    save();
    sendJson(res, 200, { ok: true });
    return true;
  }

  if (path === '/admin/api/password' && method === 'POST') {
    const payload = readJson(body) || {};
    if (!verifyPassword(payload.current || '', state.settings.adminPasswordHash)) {
      sendJson(res, 403, { error: 'current password is wrong' });
      return true;
    }
    if (String(payload.next || '').length < 6) {
      sendJson(res, 400, { error: 'password must be at least 6 characters' });
      return true;
    }
    state.settings.adminPasswordHash = hashPassword(payload.next);
    flush();
    sessions.clear();
    sendJson(res, 200, { ok: true });
    return true;
  }

  sendJson(res, 404, { error: 'not found' });
  return true;
}