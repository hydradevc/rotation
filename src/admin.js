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
import { poolSnapshot, dropRuntime, rt, clearCooldown } from './pool.js';
import { snapshot as metricsSnapshot, resetMeters } from './metrics.js';
import { clientStats, quickChat } from './proxy.js';

const SESSION_TTL = 12 * 60 * 60 * 1000;
const sessions = new Map();
const loginAttempts = new Map();

function issueSession(req, res) {
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, {
    id: token.slice(0, 8),
    created: Date.now(),
    expires: Date.now() + SESSION_TTL,
    ip: req.socket.remoteAddress || 'unknown',
    ua: String(req.headers['user-agent'] || '').slice(0, 120)
  });
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

function sendJson(res, status, payload, headers = {}) {
  const body = Buffer.from(JSON.stringify(payload));
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': body.length,
    'cache-control': 'no-store',
    ...headers
  });
  res.end(body);
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
  const base = key.baseUrl.replace(/\/+$/, '');
  const url =
    key.provider === 'anthropic'
      ? base + '/v1/models'
      : (base.endsWith('/v1') ? base : base + '/v1') + '/models';
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
    const r = rt(key);
    r.lastProbeAt = Date.now();
    r.lastStatus = res.status;
    if (res.ok) {
      clearCooldown(key);
      key.lastError = '';
      key.status = 'active';
    } else {
      key.lastError = message || `HTTP ${res.status}`;
      r.lastError = key.lastError;
    }
    return { ok: res.ok, status: res.status, ms, message };
  } catch (err) {
    const r = rt(key);
    r.lastProbeAt = Date.now();
    r.lastStatus = 0;
    key.lastError = err.message;
    r.lastError = err.message;
    return { ok: false, status: 0, ms: Date.now() - started, message: err.message };
  } finally {
    clearTimeout(timer);
  }
}

function publicState() {
  const pool = poolSnapshot();
  const settings = { ...state.settings };
  delete settings.adminPasswordHash;
  const logs = logRing.slice(0, 120);
  return {
    keys: pool.keys,
    summary: pool.summary,
    clients: state.clients.map((c) => ({
      id: c.id,
      name: c.name,
      masked: c.key.slice(0, 12) + '…' + c.key.slice(-6),
      key: c.key,
      rpm: c.rpm,
      rpmUsed: clientStats(c).rpmUsed,
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
    metrics: metricsSnapshot(),
    logs,
    uptime: Math.round(process.uptime()),
    statsStartedAt: state.totals.startedAt
  };
}

function csvEscape(value) {
  const s = String(value ?? '');
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

async function runProbeAll(limit = 6) {
  const keys = [...state.keys];
  const results = [];
  let index = 0;
  const workers = Array.from({ length: Math.min(limit, keys.length) }, async () => {
    for (;;) {
      const i = index++;
      if (i >= keys.length) return;
      const key = keys[i];
      const result = await probeKey(key);
      results.push({ id: key.id, label: key.label, ...result });
    }
  });
  await Promise.all(workers);
  save();
  return {
    total: results.length,
    ok: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok).length,
    results: results.sort((a, b) => Number(b.ok) - Number(a.ok))
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
    sendJson(res, 401, { error: 'unauthorized' });
    return true;
  }

  if (path === '/admin/api/state' && method === 'GET') {
    sendJson(res, 200, publicState());
    return true;
  }

  if (path === '/admin/api/sessions' && method === 'GET') {
    const current = cookieToken(req);
    const list = [...sessions.entries()]
      .filter(([, s]) => s.expires > Date.now())
      .map(([token, s]) => ({ id: s.id, created: s.created, expires: s.expires, ip: s.ip, ua: s.ua, current: token === current }))
      .sort((a, b) => b.created - a.created);
    sendJson(res, 200, { sessions: list });
    return true;
  }

  if (path === '/admin/api/sessions/revoke' && method === 'POST') {
    const payload = readJson(body) || {};
    if (payload.all) {
      sessions.clear();
      res.setHeader('set-cookie', 'hydra_sid=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
      sendJson(res, 200, { ok: true, revoked: 'all' });
      return true;
    }
    for (const [token, s] of sessions) {
      if (s.id === payload.id) sessions.delete(token);
    }
    sendJson(res, 200, { ok: true });
    return true;
  }

  if (path === '/admin/api/keys/bulk' && method === 'POST') {
    const payload = readJson(body) || {};
    const created = parseBulk(payload.text, { provider: payload.provider, baseUrl: payload.baseUrl });
    if (!created.length) {
      sendJson(res, 400, { error: 'no keys parsed' });
      return true;
    }
    state.keys.push(...created);
    save();
    sendJson(res, 200, { ok: true, created: created.length });
    return true;
  }

  if (path === '/admin/api/keys/probe-all' && method === 'POST') {
    const result = await runProbeAll();
    sendJson(res, 200, result);
    return true;
  }

  if (path === '/admin/api/keys/bulk-action' && method === 'POST') {
    const payload = readJson(body) || {};
    const ids = new Set(Array.isArray(payload.ids) ? payload.ids : []);
    if (!ids.size) {
      sendJson(res, 400, { error: 'no ids' });
      return true;
    }
    let affected = 0;
    if (payload.action === 'delete') {
      state.keys = state.keys.filter((k) => {
        if (ids.has(k.id)) {
          dropRuntime(k.id);
          affected += 1;
          return false;
        }
        return true;
      });
    } else if (payload.action === 'enable' || payload.action === 'disable') {
      for (const key of state.keys) {
        if (!ids.has(key.id)) continue;
        key.status = payload.action === 'enable' ? 'active' : 'disabled';
        if (payload.action === 'enable') clearCooldown(key);
        affected += 1;
      }
    } else {
      sendJson(res, 400, { error: 'unknown action' });
      return true;
    }
    save();
    sendJson(res, 200, { ok: true, affected });
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
      save();
      sendJson(res, 200, result);
      return true;
    }
    if (method === 'PATCH') {
      const payload = readJson(body) || {};
      for (const field of ['label', 'baseUrl', 'model', 'provider']) {
        if (payload[field] !== undefined) key[field] = String(payload[field]);
      }
      if (payload.provider !== undefined) key.provider = payload.provider === 'anthropic' ? 'anthropic' : 'openai';
      for (const field of ['weight', 'rpm', 'tpm']) {
        if (payload[field] !== undefined) key[field] = Math.max(0, Number(payload[field]) || 0);
      }
      if (payload.status !== undefined) {
        key.status = payload.status === 'disabled' ? 'disabled' : 'active';
      }
      if (payload.key) key.key = String(payload.key);
      if (key.status !== 'disabled') clearCooldown(key);
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

  if (path === '/admin/api/playground' && method === 'POST') {
    const payload = readJson(body) || {};
    const prompt = String(payload.prompt || '').trim();
    if (!prompt) {
      sendJson(res, 400, { error: 'prompt is empty' });
      return true;
    }
    const result = await quickChat({
      model: String(payload.model || 'gpt-4o-mini'),
      messages: [{ role: 'user', content: prompt }],
      maxTokens: Math.min(4096, Math.max(16, Number(payload.maxTokens) || 512)),
      temperature: Number.isFinite(Number(payload.temperature)) ? Number(payload.temperature) : 0.7
    });
    save();
    sendJson(res, result.ok ? 200 : 502, result);
    return true;
  }

  if (path === '/admin/api/logs' && method === 'GET') {
    const limit = Math.min(500, Number(url.searchParams.get('limit')) || 120);
    const status = url.searchParams.get('status');
    const q = (url.searchParams.get('q') || '').toLowerCase();
    let logs = logRing;
    if (status === 'ok') logs = logs.filter((l) => l.status >= 200 && l.status < 300);
    if (status === 'fail') logs = logs.filter((l) => !(l.status >= 200 && l.status < 300));
    if (q) {
      logs = logs.filter((l) =>
        [l.client, l.model, l.key, l.provider, l.err].filter(Boolean).some((v) => String(v).toLowerCase().includes(q))
      );
    }
    sendJson(res, 200, { logs: logs.slice(0, limit) });
    return true;
  }

  if (path === '/admin/api/logs.csv' && method === 'GET') {
    const header = 'time,client,model,provider,key,status,latency_ms,tokens_in,tokens_out,error';
    const rows = logRing.map((l) =>
      [
        new Date(l.ts).toISOString(),
        l.client,
        l.model,
        l.provider,
        l.key,
        l.status,
        l.ms,
        l.tin,
        l.tout,
        l.err
      ]
        .map(csvEscape)
        .join(',')
    );
    const csv = [header, ...rows].join('\n');
    res.writeHead(200, {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': 'attachment; filename="hydra-logs.csv"',
      'content-length': Buffer.byteLength(csv)
    });
    res.end(csv);
    return true;
  }

  if (path === '/admin/api/export' && method === 'GET') {
    const payload = {
      exportedAt: new Date().toISOString(),
      version: state.version,
      keys: state.keys,
      clients: state.clients,
      settings: { ...state.settings, adminPasswordHash: undefined }
    };
    sendJson(res, 200, payload, {
      'content-disposition': 'attachment; filename="hydra-backup.json"'
    });
    return true;
  }

  if (path === '/admin/api/import' && method === 'POST') {
    const payload = readJson(body) || {};
    if (!Array.isArray(payload.keys) && !Array.isArray(payload.clients)) {
      sendJson(res, 400, { error: 'nothing to import' });
      return true;
    }
    if (Array.isArray(payload.keys)) {
      state.keys = payload.keys.map((k) => normalizeKey(k)).filter(Boolean);
      for (const key of state.keys) {
        key.totals = key.totals || { req: 0, ok: 0, fail: 0, tin: 0, tout: 0 };
      }
    }
    if (Array.isArray(payload.clients)) {
      state.clients = payload.clients.map((c) => ({
        ...normalizeClient({ name: c.name, rpm: c.rpm, dailyTokens: c.dailyTokens, models: c.models }),
        key: c.key || newAccessKey()
      }));
    }
    if (payload.settings && typeof payload.settings === 'object') {
      const keepHash = state.settings.adminPasswordHash;
      state.settings = { ...state.settings, ...payload.settings, adminPasswordHash: keepHash };
    }
    save();
    sendJson(res, 200, { ok: true, keys: state.keys.length, clients: state.clients.length });
    return true;
  }

  if (path === '/admin/api/reset-stats' && method === 'POST') {
    state.totals = { req: 0, ok: 0, fail: 0, tin: 0, tout: 0, startedAt: Date.now() };
    for (const key of state.keys) key.totals = { req: 0, ok: 0, fail: 0, tin: 0, tout: 0 };
    for (const client of state.clients) {
      client.totals = { req: 0, ok: 0, fail: 0, tin: 0, tout: 0 };
      client.day = { date: '', tokens: 0 };
    }
    logRing.length = 0;
    resetMeters();
    save();
    sendJson(res, 200, { ok: true });
    return true;
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
      'sampleSize',
      'queueWaitMs',
      'circuitThreshold',
      'circuitCooldownMs',
      'autoDisableAfterAuthFails'
    ];
    for (const field of numeric) {
      if (payload[field] !== undefined) {
        const n = Number(payload[field]);
        if (Number.isFinite(n) && n >= 0) s[field] = Math.round(n);
      }
    }
    if (payload.defaultLang === 'en' || payload.defaultLang === 'ru') s.defaultLang = payload.defaultLang;
    if (['smart', 'round-robin', 'random', 'weighted'].includes(payload.policy)) s.policy = payload.policy;
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
    if (typeof payload.cors === 'boolean') s.cors = payload.cors;
    if (typeof payload.corsOrigin === 'string') s.corsOrigin = payload.corsOrigin;
    if (typeof payload.webhookUrl === 'string') s.webhookUrl = payload.webhookUrl.trim();
    if (Array.isArray(payload.webhookEvents)) s.webhookEvents = payload.webhookEvents.map(String);
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

setInterval(() => {
  const now = Date.now();
  for (const [token, session] of sessions) {
    if (session.expires < now) sessions.delete(token);
  }
  for (const [ip, bucket] of loginAttempts) {
    if (bucket.reset < now - 300000) loginAttempts.delete(ip);
  }
}, 600000).unref();