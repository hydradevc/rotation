import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startMock } from './mock-upstream.js';

const PORT = Number(process.env.UI_PORT || 8099);
const EXTERNAL = process.env.HYDRA_URL;
const HYDRA = EXTERNAL || `http://127.0.0.1:${PORT}`;
const PASS = process.env.HYDRA_PASS || 'uitest';
const CHROME = process.env.CHROME || 'chromium';
const MOCK_PORT = 9101;

const results = [];
function check(name, ok, detail = '') {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const mock = await startMock(MOCK_PORT);

  let server = null;
  let dataDir = null;
  if (!EXTERNAL) {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hydra-ui-'));
    server = spawn(process.execPath, ['server.js'], {
      cwd: path.resolve(import.meta.dirname, '..'),
      env: {
        ...process.env,
        PORT: String(PORT),
        HYDRA_DATA: dataDir,
        HYDRA_ADMIN_PASSWORD: PASS
      },
      stdio: 'ignore'
    });
    for (let i = 0; i < 100; i++) {
      try {
        if (await fetch(`${HYDRA}/healthz`).then((r) => r.ok)) break;
      } catch {
        /* not up yet */
      }
      await sleep(100);
    }
  }

  const login = await fetch(`${HYDRA}/admin/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: PASS })
  });
  const token = (login.headers.get('set-cookie') || '').split(';')[0].split('=')[1];

  const api = async (p, method = 'GET', body) => {
    const res = await fetch(HYDRA + p, {
      method,
      headers: { cookie: 'hydra_sid=' + token, 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined
    });
    return res.json();
  };

  const state = await api('/admin/api/state');
  const clientKey = (await api(`/admin/api/clients/${state.clients[0].id}/reveal`, 'POST', {})).key;
  await api('/admin/api/keys/bulk', 'POST', {
    text: [
      `alpha | sk-ui-alpha-1111 | http://127.0.0.1:${MOCK_PORT}/v1 | openai`,
      `beta | sk-ui-beta-2222 | http://127.0.0.1:${MOCK_PORT}/v1 | openai`,
      `gamma | sk-ant-ui-3333 | http://127.0.0.1:${MOCK_PORT} | anthropic`
    ].join('\n')
  });

  const chrome = spawn(
    CHROME,
    [
      '--headless=new',
      '--no-sandbox',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      '--user-data-dir=/tmp/hydra-ui2-chrome',
      '--remote-debugging-port=9388',
      'about:blank'
    ],
    { stdio: 'ignore' }
  );

  let version;
  for (let i = 0; i < 80; i++) {
    try {
      version = await fetch('http://127.0.0.1:9388/json/version').then((r) => r.json());
      break;
    } catch {
      await sleep(150);
    }
  }
  if (!version) throw new Error('chrome failed');

  const target = await fetch('http://127.0.0.1:9388/json/new?about:blank', { method: 'PUT' }).then((r) => r.json());
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r, { once: true }));

  let seq = 0;
  const cdp = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++seq;
      const handler = (event) => {
        const msg = JSON.parse(event.data);
        if (msg.id === id) {
          ws.removeEventListener('message', handler);
          msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
        }
      };
      ws.addEventListener('message', handler);
      ws.send(JSON.stringify({ id, method, params }));
    });

  const errors = [];
  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data);
    if (msg.method === 'Runtime.exceptionThrown') {
      errors.push(msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text);
    }
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
      errors.push(msg.params.args.map((a) => a.value ?? a.description).join(' '));
    }
  });

  const evaluate = async (expression) => {
    const res = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (res.exceptionDetails) throw new Error(res.exceptionDetails.text + ' ' + (res.exceptionDetails.exception?.description || ''));
    return res.result.value;
  };

  await cdp('Page.enable');
  await cdp('Runtime.enable');
  await cdp('Network.enable');
  await cdp('Network.setCookie', { name: 'hydra_sid', value: token, domain: '127.0.0.1', path: '/' });
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1100, deviceScaleFactor: 1, mobile: false });
  await cdp('Page.navigate', { url: HYDRA + '/admin' });
  await sleep(2200);

  check('panel boots', await evaluate(`!document.querySelector('#app').classList.contains('hidden')`));

  for (const view of ['overview', 'playground', 'keys', 'access', 'logs', 'analytics', 'settings', 'docs']) {
    await evaluate(`document.querySelector('.nav-item[data-view="${view}"]').click()`);
    await sleep(600);
    const visible = await evaluate(`!document.querySelector('#view-${view}').classList.contains('hidden')`);
    check(`view renders: ${view}`, visible);
  }

  check('no console errors on navigation', errors.length === 0, errors.slice(0, 3).join(' | '));

  // access keys are masked, copy pulls the secret on demand
  await evaluate(`document.querySelector('.nav-item[data-view="access"]').click()`);
  await sleep(500);
  const masked = await evaluate(`document.querySelector('.client-key span').textContent`);
  check('access keys are masked in the list', masked.includes('…'), masked);
  await evaluate(`document.querySelector('button[data-client="copy"]').click()`);
  await sleep(900);
  const copyToast = await evaluate(`[...document.querySelectorAll('.toast')].map(t=>t.textContent).join(' | ')`);
  check('copy reveals the secret on demand', /copied|скопировано/i.test(copyToast), copyToast.slice(0, 60));

  // playground
  await evaluate(`document.querySelector('.nav-item[data-view="playground"]').click()`);
  await sleep(300);
  await evaluate(`
    document.querySelector('#play-model').value = 'gpt-4o-mini';
    document.querySelector('#play-prompt').value = 'ping from playground';
    document.querySelector('#play-run').click();
  `);
  await sleep(2000);
  const playText = await evaluate(`document.querySelector('#play-out').textContent`);
  const playMeta = await evaluate(`document.querySelector('#play-meta').textContent`);
  check('playground answers through the pool', playText.includes('echo:'), playText.slice(0, 60));
  check('playground reports serving key', playMeta.includes('served by') || playMeta.includes('ответил'), playMeta.slice(0, 80));

  // keys: edit modal
  await evaluate(`document.querySelector('.nav-item[data-view="keys"]').click()`);
  await sleep(700);
  await evaluate(`document.querySelector('button[data-act="edit"]').click()`);
  await sleep(300);
  check('key edit modal opens', await evaluate(`!document.querySelector('#key-modal').classList.contains('hidden')`));
  await evaluate(`
    (() => {
      const f = document.querySelector('#key-form');
      f.elements.namedItem('label').value = 'renamed-key';
      f.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
    })()
  `);
  await sleep(1200);
  const renamed = (await api('/admin/api/state')).keys.some((k) => k.label === 'renamed-key');
  check('key edit persists', renamed);

  // bulk select + disable
  await evaluate(`document.querySelectorAll('#keys-body input[data-select]')[0].click()`);
  await sleep(200);
  const bulkVisible = await evaluate(`!document.querySelector('#keys-bulkbar').classList.contains('hidden')`);
  check('bulk bar appears', bulkVisible);
  await evaluate(`document.querySelector('button[data-bulk="disable"]').click()`);
  await sleep(1000);
  const disabledCount = (await api('/admin/api/state')).keys.filter((k) => k.status === 'disabled').length;
  check('bulk disable works', disabledCount >= 1, `${disabledCount} disabled`);

  // probe all
  await evaluate(`document.querySelector('#keys-probe-all').click()`);
  await sleep(3000);
  const toastText = await evaluate(`[...document.querySelectorAll('.toast')].map(t=>t.textContent).join(' | ')`);
  check('probe all reports results', /ok|ок/i.test(toastText), toastText.slice(0, 80));

  // analytics numbers
  await evaluate(`document.querySelector('.nav-item[data-view="analytics"]').click()`);
  await sleep(700);
  const p95 = await evaluate(`document.querySelector('#an-p95').textContent`);
  check('analytics shows percentiles', p95 !== '—', p95);

  // settings tabs
  await evaluate(`document.querySelector('.nav-item[data-view="settings"]').click()`);
  await sleep(400);
  await evaluate(`document.querySelector('#settings-tabs button[data-tab="network"]').click()`);
  await sleep(250);
  const networkVisible = await evaluate(`!document.querySelector('.tab-panel[data-tab="network"]').classList.contains('hidden')`);
  check('settings tabs switch', networkVisible);

  await evaluate(`
    (() => {
      const f = document.querySelector('#settings-form');
      f.elements.namedItem('cors').checked = true;
      f.elements.namedItem('policy').value = 'round-robin';
      f.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
    })()
  `);
  await sleep(1200);
  const settings = (await api('/admin/api/state')).settings;
  check('settings save policy+cors', settings.policy === 'round-robin' && settings.cors === true,
    `${settings.policy} / ${settings.cors}`);

  // CORS headers on the API
  const corsCheck = await fetch(HYDRA + '/v1/models', {
    headers: { authorization: 'Bearer ' + clientKey, origin: 'https://example.com' }
  });
  check('cors header emitted', corsCheck.headers.get('access-control-allow-origin') !== null,
    String(corsCheck.headers.get('access-control-allow-origin')));

  // docs page content
  await evaluate(`document.querySelector('.nav-item[data-view="docs"]').click()`);
  await sleep(400);
  const docsText = await evaluate(`document.querySelector('#doc-curl').textContent`);
  check('docs renders examples', docsText.includes('/v1/chat/completions'));

  // export / import round trip
  const exported = await (await fetch(HYDRA + '/admin/api/export', { headers: { cookie: 'hydra_sid=' + token } })).json();
  check('export contains keys', Array.isArray(exported.keys) && exported.keys.length > 0, `${exported.keys.length} keys`);
  const restored = await api('/admin/api/import', 'POST', exported);
  check('import restores keys', restored.keys === exported.keys.length, `${restored.keys}`);

  // logs csv
  const csv = await (await fetch(HYDRA + '/admin/api/logs.csv', { headers: { cookie: 'hydra_sid=' + token } })).text();
  check('csv export has header', csv.split('\n')[0].startsWith('time,client,model'));

  // prometheus + openapi
  const metricsText = await (await fetch(HYDRA + '/metrics', { headers: { cookie: 'hydra_sid=' + token } })).text();
  check('prometheus metrics exposed', metricsText.includes('hydra_requests_total') && metricsText.includes('hydra_pool_rpm'));
  const spec = await (await fetch(HYDRA + '/openapi.json')).json();
  check('openapi spec valid', spec.openapi === '3.1.0' && Boolean(spec.paths['/v1/chat/completions']));

  // anthropic model list shape
  const anthropicModels = await (
    await fetch(HYDRA + '/v1/models', { headers: { 'x-api-key': clientKey } })
  ).json();
  check('models endpoint responds', Array.isArray(anthropicModels.data));

  // language switch + persistence
  await evaluate(`document.querySelector('#lang-switch button[data-lang="ru"]').click()`);
  await sleep(300);
  const ruTitle = await evaluate(`document.querySelector('#page-title').textContent`);
  check('russian titles', /справочник/i.test(ruTitle), ruTitle);
  await evaluate(`document.querySelector('#lang-switch button[data-lang="en"]').click()`);
  await sleep(200);

  check('no console errors at the end', errors.length === 0, errors.slice(0, 3).join(' | '));

  ws.close();
  chrome.kill('SIGKILL');
  mock.close();
  if (server) server.kill('SIGTERM');
  if (dataDir) {
    await sleep(300);
    fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }

  const failed = results.filter((r) => !r).length;
  console.log(`\n${results.length - failed}/${results.length} ui checks passed`);
  if (failed) process.exitCode = 1;
}

main().catch((err) => {
  console.error('UI HARNESS ERROR', err);
  process.exit(1);
});