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

    // --- non-ASCII key labels must not break the response
    await admin('/admin/api/keys', 'DELETE');
    await admin('/admin/api/keys/bulk', 'POST', {
      text: 'ключ-с-кириллицей | sk-unicode-label-00000007 | http://127.0.0.1:' + MOCK + '/v1'
    });
    const unicode = await Promise.all(
      Array.from({ length: 6 }, () =>
        fetch(`${BASE}/v1/chat/completions`, {
          method: 'POST',
          headers: { authorization: 'Bearer ' + clientKey, 'content-type': 'application/json' },
          body: JSON.stringify({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'unicode' }] })
        })
      )
    );
    const unicodeStatuses = unicode.map((r) => r.status);
    const unicodeHeader = unicode[0].headers.get('x-hydra-key') || '';
    check('non-ASCII key label does not break the response', unicodeStatuses.every((s) => s === 200), unicodeStatuses.join(','));
    check('key label header stays ASCII-safe', /^[\x20-\x7E]*$/.test(unicodeHeader), unicodeHeader);

    // --- metrics exposure
    const metricsAnon = await fetch(`${BASE}/metrics`);
    check('metrics are closed by default', metricsAnon.status === 403, String(metricsAnon.status));
    const metricsAdmin = await fetch(`${BASE}/metrics`, { headers: { cookie } });
    check('metrics allowed for an admin session', metricsAdmin.status === 200);
    await admin('/admin/api/settings', 'POST', { metricsPublic: true });
    check('metrics can be opened explicitly', (await fetch(`${BASE}/metrics`)).status === 200);
    await admin('/admin/api/settings', 'POST', { metricsPublic: false });

    // --- upstream url policy
    const httpUpstream = await admin('/admin/api/keys/bulk', 'POST', {
      text: 'evil | sk-http-evil-000000000001 | http://example.com/v1'
    });
    check('plain http upstream to the internet is rejected', httpUpstream.status === 400, JSON.stringify(httpUpstream.data).slice(0, 80));
    const localUpstream = await admin('/admin/api/keys/bulk', 'POST', {
      text: `local | sk-local-ok-000000000002 | http://127.0.0.1:${MOCK}/v1`
    });
    check('http upstream to localhost stays allowed', localUpstream.status === 200);

    // --- webhook policy
    const webhookPrivate = await admin('/admin/api/settings', 'POST', { webhookUrl: 'https://127.0.0.1/hook' });
    check('webhook to a private address is rejected', webhookPrivate.status === 400);
    const webhookHttp = await admin('/admin/api/settings', 'POST', { webhookUrl: 'http://example.com/hook' });
    check('webhook over plain http is rejected', webhookHttp.status === 400);
    const webhookOk = await admin('/admin/api/settings', 'POST', { webhookUrl: 'https://example.com/hook' });
    check('public https webhook is accepted', webhookOk.status === 200);
    await admin('/admin/api/settings', 'POST', { webhookUrl: '' });

    // --- local rpm ceiling is not bypassed
    await admin('/admin/api/keys', 'DELETE');
    await admin('/admin/api/keys/bulk', 'POST', {
      text: `lim | sk-limit-test-000000003 | http://127.0.0.1:${MOCK}/v1`
    });
    const limited = (await admin('/admin/api/state')).data.keys;
    await admin(`/admin/api/keys/${limited[0].id}`, 'PATCH', { rpm: 1, tpm: 0 });
    await admin('/admin/api/settings', 'POST', { queueWaitMs: 0, strictLimits: true });
    const rpmBurst = await Promise.all(
      Array.from({ length: 4 }, () =>
        fetch(`${BASE}/v1/chat/completions`, {
          method: 'POST',
          headers: { authorization: 'Bearer ' + clientKey, 'content-type': 'application/json' },
          body: JSON.stringify({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'rpm test' }] })
        })
      )
    );
    const rpmOk = rpmBurst.filter((r) => r.status === 200).length;
    check('local rpm ceiling is enforced, not bypassed', rpmOk <= 1, `200s: ${rpmOk}/4`);

    await admin(`/admin/api/keys/${limited[0].id}`, 'PATCH', { rpm: 0, tpm: 1 });
    const tpmBurst = await Promise.all(
      Array.from({ length: 3 }, () =>
        fetch(`${BASE}/v1/chat/completions`, {
          method: 'POST',
          headers: { authorization: 'Bearer ' + clientKey, 'content-type': 'application/json' },
          body: JSON.stringify({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'tpm test' }] })
        })
      )
    );
    const tpmOk = tpmBurst.filter((r) => r.status === 200).length;
    check('local tpm ceiling is enforced', tpmOk === 0, `200s: ${tpmOk}/3`);
    await admin('/admin/api/settings', 'POST', { queueWaitMs: 5000, strictLimits: false });
    await admin('/admin/api/keys', 'DELETE');
    await admin('/admin/api/keys/bulk', 'POST', {
      text: `main | sk-main-ok-000000000004 | http://127.0.0.1:${MOCK}/v1`
    });

    // --- client runtime is released on delete
    const extra = await admin('/admin/api/clients', 'POST', { name: 'temp-runtime' });
    await fetch(`${BASE}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: 'Bearer ' + extra.data.client.key, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'runtime' }] })
    }).catch(() => {});
    await admin(`/admin/api/clients/${extra.data.client.id}`, 'DELETE');
    const runtimeAfter = (await admin('/admin/api/state')).data.metrics.runtime;
    check('deleted clients release their rate window', runtimeAfter.clientsRuntime <= (await admin('/admin/api/state')).data.clients.length,
      `${runtimeAfter.clientsRuntime} tracked`);

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

    // --- backup recovery
    const bakFile = path.join(dataDir, 'state.json.bak');
    check('backup file exists after writes', fs.existsSync(bakFile));
    await stop(server.child);
    fs.writeFileSync(path.join(dataDir, 'state.json'), '{ broken json');
    server = startServer(dataDir);
    await waitUp();
    const recoveredLogin = await fetch(`${BASE}/admin/api/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: PASS })
    });
    const recoveredCookie = (recoveredLogin.headers.get('set-cookie') || '').split(';')[0];
    const recovered = await (await fetch(`${BASE}/admin/api/state`, { headers: { cookie: recoveredCookie } })).json();
    check('a corrupt state.json recovers from the backup', (recovered.keys || []).length > 0, `${(recovered.keys || []).length} keys`);

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