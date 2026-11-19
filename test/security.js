import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { startMock } from './mock-upstream.js';

const PORT = 9107;
const MOCK = 9101;
const PASS = 'secpass';
const BASE = `http://127.0.0.1:${PORT}`;
const ROOT = path.resolve(import.meta.dirname, '..');

const results = [];
function check(name, ok, detail = '') {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function startServer(dataDir, extraEnv = {}) {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      HYDRA_DATA: dataDir,
      HYDRA_ADMIN_PASSWORD: PASS,
      ...extraEnv
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stderr = '';
  child.stderr.on('data', (d) => {
    stderr += d.toString();
  });
  return { child, getStderr: () => stderr };
}

async function waitUp() {
  for (let i = 0; i < 100; i++) {
    try {
      if (await fetch(`${BASE}/healthz`).then((r) => r.ok)) return;
    } catch {
      /* not up */
    }
    await sleep(100);
  }
  throw new Error('server did not start');
}

async function stop(child) {
  child.kill('SIGTERM');
  await sleep(400);
}

async function main() {
  const mock = await startMock(MOCK);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hydra-sec-'));
  let server = startServer(dataDir);
  await waitUp();

  try {
    // --- cookie flags on plain http
    const login = await fetch(`${BASE}/admin/api/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: PASS })
    });
    const cookieRaw = login.headers.get('set-cookie') || '';
    check('cookie is httpOnly', /HttpOnly/i.test(cookieRaw));
    check('cookie is SameSite=Strict', /SameSite=Strict/i.test(cookieRaw));
    check('cookie is not Secure over plain http', !/;\s*Secure/i.test(cookieRaw), cookieRaw.slice(0, 80));

    // --- cookie flags behind a TLS proxy
    const secureLogin = await fetch(`${BASE}/admin/api/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-proto': 'https' },
      body: JSON.stringify({ password: PASS })
    });
    const secureCookie = secureLogin.headers.get('set-cookie') || '';
    check('cookie is Secure behind https proxy', /;\s*Secure/i.test(secureCookie), secureCookie.slice(0, 90));
    check('cookie uses __Host- prefix when secure', secureCookie.startsWith('__Host-hydra_sid='));

    const cookie = cookieRaw.split(';')[0];
    const admin = async (p, method = 'GET', body, headers = {}) => {
      const res = await fetch(BASE + p, {
        method,
        headers: { cookie, 'content-type': 'application/json', ...headers },
        body: body ? JSON.stringify(body) : undefined
      });
      return { status: res.status, data: await res.json().catch(() => ({})) };
    };

    // --- security headers
    const page = await fetch(`${BASE}/admin`, { headers: { cookie } });
    check('x-frame-options DENY', page.headers.get('x-frame-options') === 'DENY');
    check('CSP present on panel', (page.headers.get('content-security-policy') || '').includes("default-src 'self'"));
    check('no CSP leaking onto api', !(await fetch(`${BASE}/healthz`)).headers.get('content-security-policy'));
    check('request id header', Boolean(page.headers.get('x-request-id')));

    // --- auth surface
    const noAuth = await fetch(`${BASE}/v1/models`);
    check('models requires auth', noAuth.status === 401);

    const bulk = await admin('/admin/api/keys/bulk', 'POST', {
      text: [
        `sec-key | sk-sec-plaintext-marker-123456 | http://127.0.0.1:${MOCK}/v1 | openai`,
        `sec-ant | sk-ant-sec-marker-abcdef123456 | http://127.0.0.1:${MOCK} | anthropic`
      ].join('\n')
    });
    check('keys imported', bulk.status === 200 && bulk.data.created === 2, JSON.stringify(bulk.data));

    const state = (await admin('/admin/api/state')).data;
    const clientId = state.clients[0].id;
    const revealed = await admin(`/admin/api/clients/${clientId}/reveal`, 'POST', {});
    const clientKey = revealed.data.key;
    check('client secret is revealed only on demand', typeof clientKey === 'string' && clientKey.startsWith('hydra_sk_'));
    check('state payload does not carry client secrets', !JSON.stringify(state).includes(clientKey));

    // --- secrets encrypted at rest
    await sleep(200);
    await admin('/admin/api/settings', 'POST', { maxAttempts: 8 });
    await sleep(1500);
    const stateFile = path.join(dataDir, 'state.json');
    const rawState = fs.readFileSync(stateFile, 'utf8');
    check('state.json holds no plaintext upstream key', !rawState.includes('sk-sec-plaintext-marker'));
    check('state.json holds no plaintext client key', !rawState.includes(clientKey));
    check('state.json stores sealed values', rawState.includes('enc:v1:'));
    const stateMode = fs.statSync(stateFile).mode & 0o777;
    check('state.json is 0600', stateMode === 0o600, stateMode.toString(8));
    check('master.key is 0600', (fs.statSync(path.join(dataDir, 'master.key')).mode & 0o777) === 0o600);

    // --- url key parameter is gone
    const urlKey = await fetch(`${BASE}/v1/models?key=${encodeURIComponent(clientKey)}`);
    check('query-string auth is rejected', urlKey.status === 401);

    // --- csrf
    const csrf = await fetch(`${BASE}/admin/api/keys/bulk`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json', origin: 'https://evil.example' },
      body: JSON.stringify({ text: 'evil | sk-evil-000000000000 | http://127.0.0.1:9101/v1' })
    });
    check('cross-origin admin write blocked', csrf.status === 403);

    // --- model filtering
    await admin(`/admin/api/clients/${clientId}`, 'PATCH', { models: ['gpt-*'] });
    await admin('/admin/api/settings', 'POST', { models: ['gpt-4o-mini', 'claude-3-5-sonnet'] });
    const listed = await (await fetch(`${BASE}/v1/models`, { headers: { authorization: 'Bearer ' + clientKey } })).json();
    const ids = (listed.data || []).map((m) => m.id);
    check('models endpoint filters by client allow-list', ids.length === 1 && ids[0] === 'gpt-4o-mini', JSON.stringify(ids));
    await admin(`/admin/api/clients/${clientId}`, 'PATCH', { models: [] });

    // --- daily budget reservation under concurrency
    await admin(`/admin/api/clients/${clientId}`, 'PATCH', { models: [], dailyTokens: 1200, status: 'active' });
    const bigBody = {
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: 'x'.repeat(1600) }]
    };
    const burst = await Promise.all(
      Array.from({ length: 6 }, () =>
        fetch(`${BASE}/v1/chat/completions`, {
          method: 'POST',
          headers: { authorization: 'Bearer ' + clientKey, 'content-type': 'application/json' },
          body: JSON.stringify(bigBody)
        })
      )
    );
    const statuses = burst.map((r) => r.status);
    const rejected = statuses.filter((s) => s === 429).length;
    const afterBurst = (await admin('/admin/api/state')).data;
    const used = afterBurst.clients.find((c) => c.id === clientId)?.dailyUsed || 0;
    check('parallel requests cannot overspend the daily budget', rejected >= 1, statuses.join(','));
    check('daily counter stays within the budget', used <= 1200, `${used} / 1200`);

    // --- client disconnect must not penalise the key
    const before = (await admin('/admin/api/state')).data.keys;
    await new Promise((resolve) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port: PORT,
          path: '/v1/chat/completions',
          method: 'POST',
          headers: {
            authorization: 'Bearer ' + clientKey,
            'content-type': 'application/json'
          }
        },
        (res) => {
          res.once('data', () => {
            req.destroy();
            res.destroy();
            resolve();
          });
        }
      );
      req.on('error', () => resolve());
      req.end(JSON.stringify({ model: 'gpt-4o-mini', stream: true, messages: [{ role: 'user', content: 'stream me' }] }));
    });
    await sleep(600);
    const afterDisconnect = (await admin('/admin/api/state')).data.keys;
    const beforeFails = before.reduce((a, k) => a + k.fails, 0);
    const afterFails = afterDisconnect.reduce((a, k) => a + k.fails, 0);
    check('client disconnect does not penalise the key', afterFails === beforeFails, `${beforeFails} → ${afterFails}`);

    // --- readiness
    const ready = await fetch(`${BASE}/readyz`);
    check('readyz ok with a healthy pool', ready.status === 200, String(ready.status));

    // --- sessions
    const sessions = await admin('/admin/api/sessions');
    check('sessions listed', sessions.data.sessions.length >= 1);

    // --- master key mismatch
    await stop(server.child);
    const wrongKey = crypto.randomBytes(32).toString('hex');
    server = startServer(dataDir, { HYDRA_MASTER_KEY: wrongKey });
    await waitUp();
    const login2 = await fetch(`${BASE}/admin/api/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: PASS })
    });
    const cookie2 = (login2.headers.get('set-cookie') || '').split(';')[0];
    const broken = await (await fetch(`${BASE}/admin/api/state`, { headers: { cookie: cookie2 } })).json();
    check('keys are disabled when the master key does not match', broken.security?.unreadableSecrets >= 1, JSON.stringify(broken.security));
    check('broken keys are not active', broken.keys.every((k) => k.status === 'disabled'));
    check('readyz fails without healthy keys', (await fetch(`${BASE}/readyz`)).status === 503);

    check('server stderr clean', !/uncaught|UnhandledPromise/.test(server.getStderr()), server.getStderr().slice(0, 200));
  } finally {
    server.child.kill('SIGTERM');
    mock.close();
    await sleep(300);
    fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }

  const failed = results.filter((r) => !r).length;
  console.log(`\n${results.length - failed}/${results.length} security checks passed`);
  if (failed) process.exitCode = 1;
}

main().catch((err) => {
  console.error('SECURITY HARNESS ERROR', err);
  process.exit(1);
});