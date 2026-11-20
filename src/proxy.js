import { once } from 'node:events';
import { createHash, timingSafeEqual } from 'node:crypto';
import { state, pushLog, tickRequests } from './store.js';
import {
  rt,
  pickKey,
  reserve,
  settle,
  recordLatency,
  markSuccess,
  penalize,
  msUntilSlot
} from './pool.js';
import { observe, addTokens, noteQueueWait, noteAbort } from './metrics.js';
import { emit } from './alerts.js';
import {
  openaiToAnthropic,
  anthropicToOpenAI,
  openaiResponseToAnthropic,
  anthropicResponseToOpenAI,
  syntheticAnthropicStream,
  syntheticOpenAIStream
} from './translate.js';

const MAX_BODY = 32 * 1024 * 1024;
const CLIENT_WINDOW = 60;
const CLIENT_BUCKETS = 60;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MODELS_TTL = 60000;
const MODELS_FAIL_TTL = 15000;
const MODELS_TIMEOUT = 5000;
const MODELS_PROBE_LIMIT = 8;
const modelsCache = new Map();

const clientRuntime = new Map();

function clientWindow(client) {
  let r = clientRuntime.get(client.id);
  if (!r) {
    r = { epoch: new Float64Array(CLIENT_BUCKETS).fill(-1), req: new Float64Array(CLIENT_BUCKETS) };
    clientRuntime.set(client.id, r);
  }
  const sec = Math.floor(Date.now() / 1000);
  const i = ((sec % CLIENT_BUCKETS) + CLIENT_BUCKETS) % CLIENT_BUCKETS;
  if (r.epoch[i] !== sec) {
    r.epoch[i] = sec;
    r.req[i] = 0;
  }
  r.req[i] += 1;
  let total = 0;
  for (let n = 0; n < CLIENT_BUCKETS; n++) {
    if (r.epoch[n] <= sec && r.epoch[n] > sec - CLIENT_WINDOW) total += r.req[n];
  }
  return total;
}

export function dropClientRuntime(id) {
  clientRuntime.delete(id);
}

export function clientRuntimeSize() {
  return clientRuntime.size;
}

export function clientStats(client) {
  const now = Date.now();
  const sec = Math.floor(now / 1000);
  const r = clientRuntime.get(client.id);
  let used = 0;
  if (r) {
    for (let n = 0; n < CLIENT_BUCKETS; n++) {
      if (r.epoch[n] <= sec && r.epoch[n] > sec - CLIENT_WINDOW) used += r.req[n];
    }
  }
  return { rpmUsed: Math.round(used) };
}

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

export function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error('body too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export function sendJson(res, status, payload, extraHeaders = {}) {
  const body = Buffer.from(JSON.stringify(payload));
  if (res.headersSent) return;
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': body.length,
    'cache-control': 'no-store',
    ...extraHeaders
  });
  res.end(body);
}

function errPayload(format, status, message, type = 'invalid_request_error') {
  if (format === 'anthropic') {
    return {
      type: 'error',
      error: { type: status === 429 ? 'rate_limit_error' : type, message }
    };
  }
  return {
    error: {
      message,
      type: status === 429 ? 'rate_limit_error' : status >= 500 ? 'upstream_error' : type,
      code: status
    }
  };
}

function presentedKey(req) {
  const auth = req.headers.authorization || '';
  const bearer = /^Bearer\s+(.+)$/i.exec(auth);
  if (bearer) return bearer[1].trim();
  if (req.headers['x-api-key']) return String(req.headers['x-api-key']).trim();
  return '';
}

function sameSecret(a, b) {
  const left = createHash('sha256').update(String(a)).digest();
  const right = createHash('sha256').update(String(b)).digest();
  return timingSafeEqual(left, right);
}

function authClient(req) {
  const key = presentedKey(req);
  if (!key) return { error: 'missing api key' };
  let client = null;
  for (const candidate of state.clients) {
    if (candidate.key && sameSecret(candidate.key, key)) client = candidate;
  }
  if (!client) return { error: 'invalid api key' };
  if (client.status !== 'active') return { error: 'api key disabled' };
  return { client };
}

function providerForModel(model) {
  const routes = state.settings.modelRoutes || {};
  for (const [prefix, provider] of Object.entries(routes)) {
    if (prefix && model.startsWith(prefix)) return provider === 'anthropic' ? 'anthropic' : 'openai';
  }
  return null;
}

function joinUrl(base, path) {
  const trimmed = String(base || '').replace(/\/+$/, '');
  if (/\/v1$/.test(trimmed)) return trimmed + path.replace(/^\/v1/, '');
  return trimmed + path;
}

function targetPath(kind, provider) {
  if (kind === 'count') return '/v1/messages/count_tokens';
  if (provider === 'anthropic') return '/v1/messages';
  if (kind === 'embeddings') return '/v1/embeddings';
  return '/v1/chat/completions';
}

export function parseRetryAfter(headers) {
  const retryAfter = headers.get('retry-after');
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
    const date = Date.parse(retryAfter);
    if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  }
  const reset = headers.get('x-ratelimit-reset-requests') || headers.get('x-ratelimit-reset-tokens');
  if (reset) {
    const match = /^(?:(\d+(?:\.\d+)?)h)?(?:(\d+(?:\.\d+)?)m)?(?:(\d+(?:\.\d+)?)s)?(?:(\d+(?:\.\d+)?)ms)?$/.exec(reset.trim());
    if (match) {
      const [, h, m, s, ms] = match;
      return (Number(h || 0) * 3600 + Number(m || 0) * 60 + Number(s || 0)) * 1000 + Number(ms || 0);
    }
  }
  return 0;
}

function estimateTokens(buffer) {
  if (!buffer) return 0;
  return Math.max(1, Math.round(buffer.length / 4));
}

function usageFromJson(json, format) {
  if (!json) return { tin: 0, tout: 0 };
  if (format === 'anthropic') {
    return { tin: json.usage?.input_tokens || 0, tout: json.usage?.output_tokens || 0 };
  }
  return {
    tin: json.usage?.prompt_tokens || 0,
    tout: json.usage?.completion_tokens || 0
  };
}

function usageFromTail(tail) {
  const matches = [...String(tail).matchAll(/"usage"\s*:\s*\{[^}]*\}/g)];
  if (!matches.length) return null;
  let tin = 0;
  let tout = 0;
  for (const m of matches) {
    try {
      const parsed = JSON.parse('{' + m[0] + '}').usage;
      tin = Math.max(tin, parsed.input_tokens || parsed.prompt_tokens || 0);
      tout = Math.max(tout, parsed.output_tokens || parsed.completion_tokens || 0);
    } catch {
      /* malformed fragment in the stream */
    }
  }
  if (!tin && !tout) return null;
  return { tin, tout };
}

function isRetryable(status) {
  const list = state.settings.retryStatuses || [];
  return status === 401 || status === 403 || list.includes(status);
}

function buildUpstreamHeaders(key, req) {
  const headers = {
    'content-type': 'application/json',
    accept: 'application/json'
  };
  if (key.provider === 'anthropic') {
    headers['x-api-key'] = key.key;
    headers['anthropic-version'] = req.headers['anthropic-version'] || '2023-06-01';
    if (req.headers['anthropic-beta']) headers['anthropic-beta'] = req.headers['anthropic-beta'];
  } else {
    headers.authorization = 'Bearer ' + key.key;
    if (req.headers['openai-organization']) headers['openai-organization'] = req.headers['openai-organization'];
    if (req.headers['openai-project']) headers['openai-project'] = req.headers['openai-project'];
    if (req.headers['openai-beta']) headers['openai-beta'] = req.headers['openai-beta'];
  }
  return headers;
}

function buildPayload(kind, clientFormat, keyFormat, body) {
  if (kind === 'embeddings' || kind === 'count') return body;
  if (clientFormat === keyFormat) return body;
  if (clientFormat === 'openai' && keyFormat === 'anthropic') return openaiToAnthropic(body);
  if (clientFormat === 'anthropic' && keyFormat === 'openai') return anthropicToOpenAI(body);
  return body;
}

function clientAllowsModel(client, model) {
  if (!client.models || !client.models.length) return true;
  return client.models.some((pattern) =>
    pattern.endsWith('*') ? model.startsWith(pattern.slice(0, -1)) : pattern === model
  );
}

export function chargeClient(client, { tin = 0, tout = 0, ok }) {
  client.totals.req += 1;
  if (ok) client.totals.ok += 1;
  else client.totals.fail += 1;
  client.totals.tin += tin;
  client.totals.tout += tout;
  client.lastUsed = Date.now();
}

function reserveBudget(client, estimate) {
  if (!client.dailyTokens) return { ok: true, reserved: 0 };
  const day = todayKey();
  if (client.day.date !== day) client.day = { date: day, tokens: 0 };
  if (client.day.tokens + estimate > client.dailyTokens) return { ok: false, reserved: 0 };
  client.day.tokens += estimate;
  return { ok: true, reserved: estimate };
}

function settleBudget(client, reserved, actual) {
  if (!reserved) return;
  const day = todayKey();
  if (client.day.date !== day) client.day = { date: day, tokens: 0 };
  client.day.tokens = Math.max(0, client.day.tokens + (actual - reserved));
}

function chargeTotals({ tin = 0, tout = 0, ok }) {
  state.totals.req += 1;
  if (ok) state.totals.ok += 1;
  else state.totals.fail += 1;
  state.totals.tin += tin;
  state.totals.tout += tout;
}

function logRequest(entry) {
  pushLog({ ts: Date.now(), ...entry });
}

// Key labels are user-facing and may hold non-ASCII text; Node rejects those in header values.
function headerSafe(value) {
  return String(value ?? '').replace(/[^\x20-\x7e]/g, (ch) => encodeURIComponent(ch));
}

function finishFailure(res, { clientFormat, status, message, retryAfterMs = 0 }) {
  const headers = {};
  if (retryAfterMs > 0) headers['retry-after'] = String(Math.max(1, Math.ceil(retryAfterMs / 1000)));
  sendJson(res, status, errPayload(clientFormat, status, message), headers);
}

async function pipeStream({ upstream, res, req, key, client, startedAt, estTokens, controller, reserved }) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
    'x-hydra-key': headerSafe(key.label),
    'x-hydra-provider': key.provider
  });
  res.flushHeaders?.();
  res.socket?.setNoDelay?.(true);

  const reader = upstream.body.getReader();
  let tail = '';
  let bytes = 0;
  let clientGone = false;
  let idle = setTimeout(() => controller.abort(), state.settings.streamIdleMs);
  const resetIdle = () => {
    clearTimeout(idle);
    idle = setTimeout(() => controller.abort(), state.settings.streamIdleMs);
  };

  const onClose = () => {
    if (res.writableEnded) return;
    clientGone = true;
    try {
      controller.abort();
    } catch {
      /* already closed */
    }
  };
  res.on('close', onClose);

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      resetIdle();
      bytes += value.byteLength;
      tail = (tail + Buffer.from(value).toString('utf8')).slice(-8192);
      if (!res.write(Buffer.from(value))) await once(res, 'drain');
    }
  } catch (err) {
    if (!res.writableEnded) res.end();
    settle(key, {});
    recordLatency(key, Date.now() - startedAt);

    if (clientGone) {
      noteAbort();
      settleBudget(client, reserved, 0);
      tickRequests(1, 0);
      chargeTotals({ ok: false });
      chargeClient(client, { ok: false });
      observe({ ms: Date.now() - startedAt, status: 499, client: client.name, provider: key.provider });
      logRequest({
        client: client.name,
        model: '',
        provider: key.provider,
        key: key.label,
        status: 499,
        ms: Date.now() - startedAt,
        err: 'client disconnected'
      });
      return;
    }

    penalize(key, { kind: 'network', message: err.message });
    settleBudget(client, reserved, 0);
    chargeTotals({ ok: false });
    chargeClient(client, { ok: false });
    observe({ ms: Date.now() - startedAt, status: 0, client: client.name, provider: key.provider, error: err.message });
    logRequest({
      client: client.name,
      model: '',
      provider: key.provider,
      key: key.label,
      status: 0,
      ms: Date.now() - startedAt,
      err: err.message
    });
    return;
  } finally {
    clearTimeout(idle);
    res.off('close', onClose);
  }

  if (!res.writableEnded) res.end();
  const real = usageFromTail(tail);
  const outTokens = real?.tout ?? Math.max(1, Math.round(bytes / 4));
  const inTokens = real?.tin ?? estTokens;
  settle(key, { tokenDelta: outTokens + inTokens - estTokens });
  settleBudget(client, reserved, outTokens + inTokens);
  recordLatency(key, Date.now() - startedAt);
  markSuccess(key, 200);
  key.totals.tin += inTokens;
  key.totals.tout += outTokens;
  tickRequests(1, outTokens + inTokens);
  chargeTotals({ tin: inTokens, tout: outTokens, ok: true });
  chargeClient(client, { tin: inTokens, tout: outTokens, ok: true });
  addTokens(inTokens, outTokens);
  observe({ ms: Date.now() - startedAt, status: 200, client: client.name, provider: key.provider });
}

async function upstreamModels(key) {
  const cacheKey = `${key.provider}|${key.baseUrl}`;
  const cached = modelsCache.get(cacheKey);
  const ttl = cached?.ids.length ? MODELS_TTL : MODELS_FAIL_TTL;
  if (cached && Date.now() - cached.at < ttl) return cached.ids;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('models timeout')), MODELS_TIMEOUT);
  try {
    const upstream = await fetch(joinUrl(key.baseUrl, '/v1/models'), {
      method: 'GET',
      headers: buildUpstreamHeaders(key, { headers: {} }),
      signal: controller.signal,
      redirect: 'manual'
    });
    const json = upstream.ok ? await upstream.json().catch(() => null) : null;
    const rows = Array.isArray(json?.data) ? json.data : [];
    const ids = rows
      .map((row) => (typeof row === 'string' ? row : row?.id))
      .filter(Boolean)
      .map(String);
    modelsCache.set(cacheKey, { at: Date.now(), ids });
    return ids;
  } catch {
    modelsCache.set(cacheKey, { at: Date.now(), ids: [] });
    return [];
  } finally {
    clearTimeout(timer);
  }
}

async function discoveredModels() {
  const seen = new Set();
  const probes = [];
  for (const key of state.keys) {
    if (key.status !== 'active' || !key.baseUrl) continue;
    const id = `${key.provider}|${key.baseUrl}`;
    if (seen.has(id)) continue;
    seen.add(id);
    probes.push(key);
    if (probes.length === MODELS_PROBE_LIMIT) break;
  }
  const lists = await Promise.all(probes.map((key) => upstreamModels(key)));
  return [...new Set(lists.flat())];
}

async function modelsPayload(client, format) {
  const ids = new Set([
    ...(state.settings.models || []),
    ...Object.keys(state.settings.aliases || {}),
    ...state.keys.map((k) => k.model).filter(Boolean)
  ]);
  if (!ids.size) {
    for (const id of await discoveredModels()) ids.add(id);
  }
  const list = [...ids].filter((id) => clientAllowsModel(client, id));
  if (format === 'anthropic') {
    const data = list.map((id) => ({ id, type: 'model', display_name: id, created_at: new Date(0).toISOString() }));
    return { data, has_more: false, first_id: data[0]?.id || null, last_id: data[data.length - 1]?.id || null };
  }
  return { object: 'list', data: list.map((id) => ({ id, object: 'model', created_by: 'hydra', owned_by: 'hydra' })) };
}

export async function handleProxy(req, res, url, bodyBuf) {
  const path = url.pathname;
  const isCount = path === '/v1/messages/count_tokens';
  const isMessages = path === '/v1/messages' || isCount;
  const clientFormat = isMessages ? 'anthropic' : 'openai';
  const kind = isCount ? 'count' : isMessages ? 'messages' : path === '/v1/embeddings' ? 'embeddings' : 'chat';

  const auth = authClient(req);
  if (auth.error) {
    sendJson(res, 401, errPayload(clientFormat, 401, auth.error, 'authentication_error'));
    return;
  }
  const { client } = auth;

  if (path === '/v1/models') {
    sendJson(res, 200, await modelsPayload(client, clientFormat));
    return;
  }

  if (req.method !== 'POST') {
    sendJson(res, 405, errPayload(clientFormat, 405, 'method not allowed'));
    return;
  }

  let body;
  try {
    body = JSON.parse(bodyBuf.toString('utf8') || '{}');
  } catch {
    sendJson(res, 400, errPayload(clientFormat, 400, 'invalid json body'));
    return;
  }

  const requestedModel = String(body.model || '');
  const model = state.settings.aliases?.[requestedModel] || requestedModel;
  if (!model) {
    sendJson(res, 400, errPayload(clientFormat, 400, 'model is required'));
    return;
  }
  if (!clientAllowsModel(client, model)) {
    sendJson(res, 403, errPayload(clientFormat, 403, `model ${model} is not allowed for this key`, 'permission_error'));
    return;
  }

  const day = todayKey();
  if (client.day.date !== day) client.day = { date: day, tokens: 0 };

  const startedAt = Date.now();
  const estTokens = estimateTokens(bodyBuf);

  const budget = reserveBudget(client, estTokens);
  if (!budget.ok) {
    sendJson(res, 429, errPayload(clientFormat, 429, 'daily token budget exhausted'), { 'retry-after': '60' });
    return;
  }
  const reserved = budget.reserved;
  if (client.rpm) {
    const used = clientWindow(client);
    if (used > client.rpm) {
      settleBudget(client, reserved, 0);
      sendJson(res, 429, errPayload(clientFormat, 429, 'client rpm limit reached'), { 'retry-after': '5' });
      return;
    }
  }

  const provider = providerForModel(model);
  const settings = state.settings;
  const tried = new Set();
  let attempts = 0;
  let lastFailure = null;
  let waitedMs = 0;
  const wantsStream = Boolean(body.stream) && kind !== 'embeddings';

  while (attempts < settings.maxAttempts && Date.now() - startedAt < settings.deadlineMs) {
    const key = pickKey({ provider, nativeFormat: clientFormat, exclude: tried });

    if (!key) {
      const left = settings.deadlineMs - (Date.now() - startedAt);
      const wait = msUntilSlot({ provider });
      const budget = Math.min(settings.queueWaitMs || 0, left);
      if (wait !== null && wait <= budget - waitedMs) {
        const pause = Math.max(wait, 25);
        waitedMs += pause;
        noteQueueWait(pause);
        await sleep(pause);
        continue;
      }
      break;
    }

    tried.add(key.id);
    attempts += 1;
    reserve(key, estTokens);
    key.totals.req += 1;

    const keyFormat = key.provider;
    const sameFormat = keyFormat === clientFormat;
    const upstreamStream = wantsStream && sameFormat;

    let outbound;
    if (sameFormat) {
      outbound = bodyBuf;
    } else {
      if (kind === 'embeddings') {
        settle(key, {});
        continue;
      }
      const payload = buildPayload(kind, clientFormat, keyFormat, body);
      outbound = Buffer.from(JSON.stringify({ ...payload, stream: upstreamStream || undefined }));
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('upstream timeout')), settings.upstreamTimeoutMs);

    let upstream;
    try {
      upstream = await fetch(joinUrl(key.baseUrl, targetPath(kind, keyFormat)), {
        method: 'POST',
        headers: buildUpstreamHeaders(key, req),
        body: outbound,
        signal: controller.signal,
        redirect: 'manual'
      });
    } catch (err) {
      clearTimeout(timer);
      settle(key, {});
      key.totals.fail += 1;
      penalize(key, { kind: 'network', message: err.message });
      lastFailure = { status: 502, message: err.message };
      continue;
    }
    clearTimeout(timer);

    if (!upstream.ok) {
      const text = await upstream.text().catch(() => '');
      settle(key, {});
      key.totals.fail += 1;

      if (!isRetryable(upstream.status)) {
        let parsed = null;
        try {
          parsed = JSON.parse(text);
        } catch {
          /* upstream returned plain text */
        }
        let outBody = parsed || errPayload(clientFormat, upstream.status, text.slice(0, 500) || 'upstream error');
        if (!sameFormat && parsed) {
          outBody =
            clientFormat === 'openai'
              ? openaiResponseToAnthropic(parsed, model)
              : anthropicResponseToOpenAI(parsed, model);
        }
        const status = upstream.status;
        const ms = Date.now() - startedAt;
        settleBudget(client, reserved, 0);
        chargeTotals({ ok: false });
        chargeClient(client, { ok: false });
        observe({ ms, status, model, client: client.name, provider: key.provider, error: text.slice(0, 60) });
        logRequest({ client: client.name, model, provider: key.provider, key: key.label, status, ms, attempts, err: text.slice(0, 160) });
        sendJson(res, status, outBody);
        return;
      }

      const kindOfError = upstream.status === 401 || upstream.status === 403 ? 'auth' : upstream.status === 429 ? 'rate' : 'upstream';
      const waited = penalize(key, {
        kind: kindOfError,
        retryAfterMs: parseRetryAfter(upstream.headers),
        message: text.slice(0, 160)
      });
      if (kindOfError === 'auth' && rt(key).authFails >= settings.autoDisableAfterAuthFails) {
        key.status = 'disabled';
        emit('key-down', { keyId: key.id, label: key.label, fails: rt(key).authFails, error: key.lastError });
      }
      lastFailure = { status: upstream.status, message: text.slice(0, 200), waited };
      continue;
    }

    if (upstreamStream) {
      await pipeStream({ upstream, res, req, key, client, startedAt, estTokens, controller, reserved });
      key.totals.ok += 1;
      logRequest({
        client: client.name,
        model,
        provider: key.provider,
        key: key.label,
        status: 200,
        ms: Date.now() - startedAt,
        attempts,
        stream: true
      });
      return;
    }

    const rawBuf = Buffer.from(await upstream.arrayBuffer());
    let parsed;
    try {
      parsed = JSON.parse(rawBuf.toString('utf8'));
    } catch {
      parsed = { raw: rawBuf.toString('utf8') };
    }

    const outBody = sameFormat
      ? parsed
      : clientFormat === 'anthropic'
        ? openaiResponseToAnthropic(parsed, model)
        : anthropicResponseToOpenAI(parsed, model);

    const usage = usageFromJson(parsed, keyFormat);
    if (!usage.tin && !usage.tout) usage.tin = estTokens;

    settle(key, { tokenDelta: usage.tin + usage.tout - estTokens });
    settleBudget(client, reserved, usage.tin + usage.tout);
    recordLatency(key, Date.now() - startedAt);
    markSuccess(key, 200);
    key.totals.ok += 1;
    key.totals.tin += usage.tin;
    key.totals.tout += usage.tout;
    tickRequests(1, usage.tin + usage.tout);
    chargeTotals({ tin: usage.tin, tout: usage.tout, ok: true });
    chargeClient(client, { tin: usage.tin, tout: usage.tout, ok: true });
    addTokens(usage.tin, usage.tout);
    observe({
      ms: Date.now() - startedAt,
      status: 200,
      model,
      client: client.name,
      provider: key.provider
    });
    logRequest({
      client: client.name,
      model,
      provider: key.provider,
      key: key.label,
      status: 200,
      ms: Date.now() - startedAt,
      attempts,
      tin: usage.tin,
      tout: usage.tout
    });

    if (wantsStream) {
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-hydra-key': headerSafe(key.label)
      });
      res.end(
        clientFormat === 'anthropic' ? syntheticAnthropicStream(outBody, model) : syntheticOpenAIStream(outBody, model)
      );
      return;
    }

    const out = sameFormat ? rawBuf : Buffer.from(JSON.stringify(outBody));
    res.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': out.length,
      'cache-control': 'no-store',
      'x-hydra-key': headerSafe(key.label),
      'x-hydra-provider': key.provider,
      'x-hydra-attempts': String(attempts)
    });
    res.end(out);
    return;
  }

  const status = lastFailure?.status === 429 ? 429 : lastFailure ? 502 : 503;
  const message =
    status === 503
      ? 'no upstream key available — add keys to the pool or wait for cooldowns'
      : lastFailure?.message || 'upstream failed';
  const retryAfter = lastFailure?.waited || Math.min(settings.queueWaitMs || 5000, 15000);
  settleBudget(client, reserved, 0);
  chargeTotals({ ok: false });
  chargeClient(client, { ok: false });
  observe({ ms: Date.now() - startedAt, status, model, client: client.name, provider: provider || '-', error: message.slice(0, 60) });
  logRequest({
    client: client.name,
    model,
    provider: provider || '-',
    key: '-',
    status,
    ms: Date.now() - startedAt,
    attempts,
    err: message
  });
  emit('pool-exhausted', { model, attempts, status });
  finishFailure(res, { clientFormat, status, message, retryAfterMs: retryAfter });
}

export async function quickChat({ model, messages, maxTokens = 512, temperature = 0.7 }) {
  const startedAt = Date.now();
  const settings = state.settings;
  const provider = providerForModel(model);
  const body = { model, messages, max_tokens: maxTokens, temperature };
  const estTokens = estimateTokens(Buffer.from(JSON.stringify(body)));
  const tried = new Set();
  let attempts = 0;
  let lastError = '';

  while (attempts < Math.min(settings.maxAttempts, 6) && Date.now() - startedAt < 60000) {
    const key = pickKey({ provider, nativeFormat: 'openai', exclude: tried });
    if (!key) break;
    tried.add(key.id);
    attempts += 1;
    reserve(key, estTokens);
    key.totals.req += 1;

    const payload = buildPayload('chat', 'openai', key.provider, body);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('timeout')), Math.min(settings.upstreamTimeoutMs, 60000));
    try {
      const upstream = await fetch(joinUrl(key.baseUrl, targetPath('chat', key.provider)), {
        method: 'POST',
        headers: buildUpstreamHeaders(key, { headers: {} }),
        body: Buffer.from(JSON.stringify(payload)),
        signal: controller.signal
      });
      clearTimeout(timer);
      const text = await upstream.text();
      settle(key, {});
      if (!upstream.ok) {
        key.totals.fail += 1;
        penalize(key, {
          kind: upstream.status === 401 || upstream.status === 403 ? 'auth' : 'rate',
          retryAfterMs: parseRetryAfter(upstream.headers),
          message: text.slice(0, 120)
        });
        lastError = text.slice(0, 300) || `HTTP ${upstream.status}`;
        continue;
      }
      const parsed = JSON.parse(text);
      const answer =
        key.provider === 'anthropic'
          ? (parsed.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('')
          : parsed.choices?.[0]?.message?.content || '';
      const usage = usageFromJson(parsed, key.provider);
      recordLatency(key, Date.now() - startedAt);
      markSuccess(key, 200);
      key.totals.ok += 1;
      key.totals.tin += usage.tin;
      key.totals.tout += usage.tout;
      observe({
        ms: Date.now() - startedAt,
        status: 200,
        model,
        client: 'playground',
        provider: key.provider
      });
      return {
        ok: true,
        text: answer,
        model: parsed.model || model,
        key: key.label,
        provider: key.provider,
        ms: Date.now() - startedAt,
        usage
      };
    } catch (err) {
      clearTimeout(timer);
      settle(key, {});
      penalize(key, { kind: 'network', message: err.message });
      lastError = err.message;
    }
  }

  observe({ ms: Date.now() - startedAt, status: 502, model, client: 'playground', error: lastError.slice(0, 60) });
  return { ok: false, error: lastError || 'no upstream key available', ms: Date.now() - startedAt };
}