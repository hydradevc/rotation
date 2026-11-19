import { spawn } from 'node:child_process';

const HYDRA = process.env.HYDRA_URL || 'http://127.0.0.1:8099';
const PASS = process.env.HYDRA_PASS || 'gK7Ra6g0o4Vd';
const CHROME = process.env.CHROME || 'chromium';

const results = [];
function check(name, ok, detail = '') {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
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

  const chrome = spawn(
    CHROME,
    [
      '--headless=new',
      '--no-sandbox',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      '--user-data-dir=/tmp/ui-chrome',
      '--remote-debugging-port=9355',
      'about:blank'
    ],
    { stdio: 'ignore' }
  );

  let version;
  for (let i = 0; i < 80; i++) {
    try {
      version = await fetch('http://127.0.0.1:9355/json/version').then((r) => r.json());
      break;
    } catch {
      await sleep(150);
    }
  }
  if (!version) throw new Error('chrome failed');

  const target = await fetch('http://127.0.0.1:9355/json/new?about:blank', { method: 'PUT' }).then((r) => r.json());
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

  const evaluate = async (expression) => {
    const res = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (res.exceptionDetails) throw new Error(res.exceptionDetails.text + ' ' + (res.exceptionDetails.exception?.description || ''));
    return res.result.value;
  };

  await cdp('Page.enable');
  await cdp('Network.enable');
  await cdp('Network.setCookie', { name: 'hydra_sid', value: token, domain: '127.0.0.1', path: '/' });
  await cdp('Page.navigate', { url: HYDRA + '/admin' });
  await sleep(2000);

  check('panel boots into app', await evaluate(`!document.querySelector('#app').classList.contains('hidden')`));

  const before = await api('/admin/api/state');

  // --- import through the form
  await evaluate(`document.querySelector('.nav-item[data-view="keys"]').click()`);
  await sleep(300);
  await evaluate(`
    document.querySelector('#import-provider').value = 'openai';
    document.querySelector('#import-baseurl').value = 'http://127.0.0.1:9101/v1';
    document.querySelector('#import-text').value = 'ui-key-1 | sk-ui-test-111aaa\\nui-key-2 | sk-ui-test-222bbb';
    document.querySelector('#import-btn').click();
  `);
  await sleep(1200);
  let after = await api('/admin/api/state');
  check('import form adds keys', after.keys.length === before.keys.length + 2, `${before.keys.length} → ${after.keys.length}`);

  // --- search filter
  await evaluate(`(() => { const el = document.querySelector('#keys-search'); el.value = 'ui-key-1'; el.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await sleep(300);
  const rows = await evaluate(`document.querySelectorAll('#keys-body tr').length`);
  check('search filters rows', rows === 1, `${rows} row(s)`);
  await evaluate(`(() => { const el = document.querySelector('#keys-search'); el.value = ''; el.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await sleep(300);

  // --- toggle a key off
  const targetKey = after.keys.find((k) => k.label === 'ui-key-1');
  await evaluate(`document.querySelector('button[data-act="toggle"][data-id="${targetKey.id}"]').click()`);
  await sleep(900);
  after = await api('/admin/api/state');
  check(
    'toggle disables key',
    after.keys.find((k) => k.id === targetKey.id)?.status === 'disabled'
  );

  // --- probe a key
  await evaluate(`document.querySelector('button[data-act="probe"][data-id="${targetKey.id}"]').click()`);
  await sleep(1600);
  const toastText = await evaluate(`document.querySelector('.toast')?.textContent || ''`);
  check('probe returns a toast', toastText.includes('OK') || toastText.includes('FAIL'), toastText);

  // --- delete with confirm modal
  await evaluate(`document.querySelector('button[data-act="delete"][data-id="${targetKey.id}"]').click()`);
  await sleep(300);
  await evaluate(`document.querySelector('#modal-ok').click()`);
  await sleep(900);
  after = await api('/admin/api/state');
  check('delete removes key', !after.keys.some((k) => k.id === targetKey.id));

  // --- access key creation
  await evaluate(`document.querySelector('.nav-item[data-view="access"]').click()`);
  await sleep(300);
  const clientsBefore = (await api('/admin/api/state')).clients.length;
  await evaluate(`
    document.querySelector('#client-name').value = 'ui-test';
    document.querySelector('#client-rpm').value = '120';
    document.querySelector('#client-create').click();
  `);
  await sleep(1000);
  after = await api('/admin/api/state');
  check('client created from UI', after.clients.length === clientsBefore + 1);
  const created = after.clients.find((c) => c.name === 'ui-test');
  check('client shows a usable key', Boolean(created && created.key.startsWith('hydra_sk_')));

  // --- settings save
  await evaluate(`document.querySelector('.nav-item[data-view="settings"]').click()`);
  await sleep(500);
  const attemptsBefore = (await api('/admin/api/state')).settings.maxAttempts;
  await evaluate(`
    (() => {
      const form = document.querySelector('#settings-form');
      form.elements.namedItem('maxAttempts').value = '11';
      form.querySelector('button[type="submit"]').click();
    })()
  `);
  await sleep(1200);
  after = await api('/admin/api/state');
  check('settings persist', after.settings.maxAttempts === 11, `${attemptsBefore} → ${after.settings.maxAttempts}`);

  // --- api smoke with the new client key
  const smoke = await fetch(HYDRA + '/v1/chat/completions', {
    method: 'POST',
    headers: { authorization: 'Bearer ' + created.key, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'ui smoke' }] })
  });
  check('new client key serves traffic', smoke.status === 200, `status ${smoke.status}`);

  // --- language persistence
  await evaluate(`document.querySelector('#lang-switch button[data-lang="ru"]').click()`);
  await sleep(300);
  await cdp('Page.reload');
  await sleep(1800);
  const lang = await evaluate(`document.documentElement.lang`);
  check('language choice persists after reload', lang === 'ru', lang);
  await evaluate(`document.querySelector('#lang-switch button[data-lang="en"]').click()`);

  // --- logout shows the login screen
  await evaluate(`document.querySelector('#logout').click()`);
  await sleep(1500);
  const loginVisible = await evaluate(`!document.querySelector('#login').classList.contains('hidden')`);
  check('logout returns to login screen', loginVisible);

  // --- wrong password shows error text
  await evaluate(`document.querySelector('#login-password').value = 'nope'; document.querySelector('#login-form').requestSubmit()`);
  await sleep(800);
  const err = await evaluate(`document.querySelector('#login-error').textContent`);
  check('wrong password shows error', err.length > 0, err);

  ws.close();
  chrome.kill('SIGKILL');

  const failed = results.filter((r) => !r).length;
  console.log(`\n${results.length - failed}/${results.length} ui checks passed`);
  if (failed) process.exitCode = 1;
}

main().catch((err) => {
  console.error('UI HARNESS ERROR', err);
  process.exit(1);
});