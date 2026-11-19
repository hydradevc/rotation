import { startMock } from './mock-upstream.js';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert';

const MOCK_PORT = 9101;
const HYDRA_PORT = 9102;
const PASS = 'testpass123';
const BASE = `http://127.0.0.1:${HYDRA_PORT}`;

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
  if (!ok) process.exitCode = 1;
}

async function waitFor(fn, timeoutMs = 10000) {
  const start = Date.now();
  for (;;) {
    try {
      const value = await fn();
      if (value) return value;
    } catch {
      /* keep waiting */
    }
    if (Date.now() - start > timeoutMs) throw new Error('timeout waiting for server');
    await new Promise((r) => setTimeout(r, 100));
  }
}

function parseSetCookie(res) {
  const raw = res.headers.get('set-cookie') || '';
  return raw.split(';')[0];
}

async function main() {
  const mock = await startMock(MOCK_PORT);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hydra-test-'));
  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.resolve(import.meta.dirname, '..'),
    env: {
      ...process.env,
      PORT: String(HYDRA_PORT),
      HYDRA_DATA: dataDir,
      HYDRA_ADMIN_PASSWORD: PASS
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stderr = '';
  child.stderr.on('data', (d) => {
    stderr += d.toString();
  });

  try {
    await waitFor(() => fetch(`${BASE}/healthz`).then((r) => r.ok));

    const login = await fetch(`${BASE}/admin/api/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: PASS })
    });
    const cookie = parseSetCookie(login);
    check('admin login', login.ok && cookie.length > 5, `status ${login.status}`);

    const badLogin = await fetch(`${BASE}/admin/api/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'wrong' })
    });
    check('admin rejects wrong password', badLogin.status === 401);

    const unauth = await fetch(`${BASE}/admin/api/state`);
    check('admin api requires session', unauth.status === 401);

    const admin = async (path, method = 'GET', body) => {
      const res = await fetch(BASE + path, {
        method,
        headers: { cookie, 'content-type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined
      });
      return res.json();
    };

    let s = await admin('/admin/api/state');
    const CLIENT_KEY = (
      await admin(`/admin/api/clients/${s.clients[0].id}/reveal`, 'POST', {})
    ).key;
    check('default access key exists', s.clients.length === 1 && CLIENT_KEY.startsWith('hydra_sk_'));
    check('state payload hides the access key', !s.clients[0].key);

    const chat = async (payload, opts = {}) => {
      const res = await fetch(`${BASE}${opts.path || '/v1/chat/completions'}`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${opts.key || CLIENT_KEY}`,
          'content-type': 'application/json',
          ...(opts.headers || {})
        },
        body: JSON.stringify(payload)
      });
      const text = await res.text();
      let json = null;
      try {
        json = JSON.parse(text);
      } catch {
        /* stream body */
      }
      return { status: res.status, headers: res.headers, text, json };
    };

    // --- auth on proxy
    const noAuth = await fetch(`${BASE}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'mock-model', messages: [] })
    });
    check('proxy requires access key', noAuth.status === 401);

    // --- import 20 keys
    const lines = Array.from({ length: 20 }, (_, i) => `node-${i}|sk-pool-${String(i).padStart(3, '0')}x9|http://127.0.0.1:${MOCK_PORT}/v1`);
    const bulk = await admin('/admin/api/keys/bulk', 'POST', { text: lines.join('\n') });
    check('bulk import 20 keys', bulk.created === 20, JSON.stringify(bulk));

    s = await admin('/admin/api/state');
    check('state shows 20 keys', s.keys.length === 20, `got ${s.keys.length}`);
    check('capacity aggregated', s.summary.capacityRpm === 1200, `capacityRpm=${s.summary.capacityRpm}`);

    // --- 60 concurrent completions
    const t0 = Date.now();
    const wave = await Promise.all(
      Array.from({ length: 60 }, () =>
        chat({ model: 'mock-model', messages: [{ role: 'user', content: 'hello there' }] })
      )
    );
    const elapsed = Date.now() - t0;
    const okCount = wave.filter((r) => r.status === 200).length;
    const usedKeys = new Set(wave.map((r) => r.headers.get('x-hydra-key')).filter(Boolean));
    check('60 concurrent requests succeed', okCount === 60, `${okCount}/60 in ${elapsed}ms`);
    check('requests spread across keys', usedKeys.size >= 15, `${usedKeys.size} distinct keys`);
    check('single request latency sane', elapsed / 60 < 200, `${Math.round(elapsed / 60)}ms avg wall per request`);

    const sample = wave[0];
    check('usage propagated', sample.json?.usage?.completion_tokens === 12, JSON.stringify(sample.json?.usage));

    // --- rate limit absorption: 6 keys x 5 rpm = 30/min capacity
    await admin('/admin/api/keys', 'DELETE');
    const rl = Array.from({ length: 6 }, (_, i) => `rl-${i}|sk-limit-5-${i}abc|http://127.0.0.1:${MOCK_PORT}/v1`);
    await admin('/admin/api/keys/bulk', 'POST', { text: rl.join('\n') });

    const burst = await Promise.all(
      Array.from({ length: 25 }, () =>
        chat({ model: 'mock-model', messages: [{ role: 'user', content: 'rate test' }] })
      )
    );
    const burstOk = burst.filter((r) => r.status === 200).length;
    check('25 requests absorbed by 6 rate-limited keys (30 rpm ceiling)', burstOk === 25, `${burstOk}/25`);

    const overkill = await Promise.all(
      Array.from({ length: 12 }, () =>
        chat({ model: 'mock-model', messages: [{ role: 'user', content: 'rate test 2' }] })
      )
    );
    const overkill429 = overkill.filter((r) => r.status === 429).length;
    check('pool reports 429 once saturated', overkill429 > 0, `${overkill429}/12 rejected`);

    // --- streaming
    await admin('/admin/api/keys', 'DELETE');
    await admin('/admin/api/keys/bulk', 'POST', {
      text: Array.from({ length: 3 }, (_, i) => `s-${i}|sk-stream-${i}xyz|http://127.0.0.1:${MOCK_PORT}/v1`).join('\n')
    });
    const stream = await chat({
      model: 'mock-model',
      stream: true,
      messages: [{ role: 'user', content: 'stream please' }]
    });
    check('stream status 200', stream.status === 200, `status ${stream.status}`);
    check('stream contains SSE frames', stream.text.includes('data: ') && stream.text.includes('[DONE]'));
    check('stream content arrives', stream.text.includes('echo:m') && stream.text.includes('ock-mo'));

    // --- anthropic native
    await admin('/admin/api/keys', 'DELETE');
    await admin('/admin/api/keys/bulk', 'POST', {
      text: `claude-1|sk-ant-test-111|http://127.0.0.1:${MOCK_PORT}|anthropic`
    });
    const anthropicReq = await chat(
      {
        model: 'claude-3-5-sonnet',
        max_tokens: 64,
        messages: [{ role: 'user', content: 'hi' }]
      },
      { path: '/v1/messages' }
    );
    check('anthropic endpoint works natively', anthropicReq.status === 200 && anthropicReq.json?.type === 'message',
      JSON.stringify(anthropicReq.json).slice(0, 120));

    // --- cross format: openai client shape, anthropic-only pool
    const cross = await chat({ model: 'claude-3-5-sonnet', messages: [{ role: 'user', content: 'cross' }] });
    check('openai-shaped request routed to anthropic key', cross.status === 200 && Boolean(cross.json?.choices?.[0]?.message),
      JSON.stringify(cross.json).slice(0, 120));

    // --- cross format the other way
    await admin('/admin/api/keys', 'DELETE');
    await admin('/admin/api/keys/bulk', 'POST', {
      text: `oa-1|sk-openai-xyz111|http://127.0.0.1:${MOCK_PORT}/v1`
    });
    const cross2 = await chat(
      { model: 'gpt-x', max_tokens: 32, messages: [{ role: 'user', content: [{ type: 'text', text: 'cross back' }] }] },
      { path: '/v1/messages' }
    );
    check(
      'anthropic-shaped request routed to openai key',
      cross2.status === 200 && cross2.json?.type === 'message' && Boolean(cross2.json?.content?.[0]?.text?.startsWith('echo:')),
      JSON.stringify(cross2.json).slice(0, 160)
    );

    // --- streaming anthropic native
    const streamA = await chat(
      { model: 'gpt-x', max_tokens: 32, stream: true, messages: [{ role: 'user', content: 'hi' }] },
      { path: '/v1/messages' }
    );
    check('cross-format stream synthesized (anthropic sse)', streamA.text.includes('message_start') && streamA.text.includes('message_stop'));

    // --- failover on 401 key
    await admin('/admin/api/keys', 'DELETE');
    await admin('/admin/api/keys/bulk', 'POST', {
      text: [
        `bad-1|sk-bad-key-111111|http://127.0.0.1:${MOCK_PORT}/v1`,
        `good-1|sk-good-key-222222|http://127.0.0.1:${MOCK_PORT}/v1`
      ].join('\n')
    });
    const failover = await chat({ model: 'mock-model', messages: [{ role: 'user', content: 'failover' }] });
    check('bad key transparently failed over', failover.status === 200, `status ${failover.status}`);

    // --- stats
    s = await admin('/admin/api/state');
    const totalReqs = s.totals.req;
    check('stats accumulated', totalReqs > 80, `totals.req=${totalReqs}`);
    check('token accounting aggregated', s.totals.tout > 0, `tout=${s.totals.tout}`);

    const logs = await admin('/admin/api/state');
    check('request log populated', logs.logs.length > 0, `${logs.logs.length} entries`);

    // --- v1.1 API surface
    const play = await admin('/admin/api/playground', 'POST', { model: 'mock-model', prompt: 'hello', maxTokens: 32 });
    check('playground answers through the pool', play.ok === true && String(play.text).includes('echo:'), JSON.stringify(play).slice(0, 80));

    const probeAll = await admin('/admin/api/keys/probe-all', 'POST', {});
    check('probe-all reports results', typeof probeAll.total === 'number' && probeAll.total >= 1, `${probeAll.ok}/${probeAll.total}`);

    const snapshot = await admin('/admin/api/state');
    const ids = snapshot.keys.slice(0, 2).map((k) => k.id);
    const bulkResult = await admin('/admin/api/keys/bulk-action', 'POST', { action: 'disable', ids });
    check('bulk action disables keys', bulkResult.affected === ids.length, JSON.stringify(bulkResult));

    const exportPayload = await (await fetch(`${BASE}/admin/api/export`, { headers: { cookie } })).json();
    check('export contains keys', Array.isArray(exportPayload.keys) && exportPayload.keys.length > 0, `${exportPayload.keys.length} keys`);

    const imported = await admin('/admin/api/import', 'POST', exportPayload);
    check('import restores the pool', imported.keys === exportPayload.keys.length, `${imported.keys}`);

    const metricsText = await (await fetch(`${BASE}/metrics`, { headers: { cookie } })).text();
    check('prometheus endpoint', metricsText.includes('hydra_pool_rpm') && metricsText.includes('hydra_requests_total'));

    const spec = await (await fetch(`${BASE}/openapi.json`)).json();
    check('openapi endpoint', spec.openapi === '3.1.0' && Boolean(spec.paths['/v1/messages']));

    const sessions = await admin('/admin/api/sessions');
    check('sessions listed', Array.isArray(sessions.sessions) && sessions.sessions.length >= 1);

    const anonModels = await fetch(`${BASE}/v1/models`);
    check('models endpoint requires auth', anonModels.status === 401);

    check('server stderr clean', !/Error|throw/.test(stderr), stderr.slice(0, 200));
  } finally {
    child.kill('SIGTERM');
    mock.close();
  }

  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
}

main().catch((err) => {
  console.error('HARNESS ERROR', err);
  process.exit(1);
});