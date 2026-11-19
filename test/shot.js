import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { startMock } from './mock-upstream.js';

const HYDRA = process.env.HYDRA_URL || 'http://127.0.0.1:8099';
const PASS = process.env.HYDRA_PASS || 'repopass';
const OUT = path.resolve(import.meta.dirname, '..', 'docs', 'screenshots');
const CHROME = process.env.CHROME || 'chromium';
const WARMUP_MS = Number(process.env.WARMUP_MS || 50000);
const ONLY = (process.env.SHOTS || '').split(',').map((s) => s.trim()).filter(Boolean);

let trafficOn = false;

async function login() {
  const res = await fetch(`${HYDRA}/admin/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: PASS })
  });
  if (!res.ok) throw new Error('login failed: ' + res.status);
  return (res.headers.get('set-cookie') || '').split(';')[0].split('=')[1];
}

async function admin(token, p, method = 'GET', body) {
  const res = await fetch(HYDRA + p, {
    method,
    headers: { cookie: 'hydra_sid=' + token, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  });
  return res.json();
}

async function prepare(token) {
  const state = await admin(token, '/admin/api/state');
  const clientKey = state.clients[0].key;
  for (const c of state.clients.slice(1)) await admin(token, `/admin/api/clients/${c.id}`, 'DELETE');
  await admin(token, '/admin/api/keys', 'DELETE');

  const lines = [];
  for (let i = 0; i < 24; i++) {
    lines.push(`openai-${String(i).padStart(2, '0')} | sk-proj-${(100000 + i * 37).toString(36)}a${i}xyz | http://127.0.0.1:9101/v1 | openai`);
  }
  for (let i = 0; i < 8; i++) {
    lines.push(`claude-${i} | sk-ant-api03-${(90000 + i).toString(36)}zz${i} | http://127.0.0.1:9101 | anthropic`);
  }
  for (let i = 0; i < 4; i++) {
    lines.push(`free-tier-${i} | sk-limit-3-${i}k${i} | http://127.0.0.1:9101/v1 | openai`);
  }
  await admin(token, '/admin/api/keys/bulk', 'POST', { text: lines.join('\n') });
  const seeded = await admin(token, '/admin/api/state');
  for (const key of seeded.keys) {
    await admin(token, `/admin/api/keys/${key.id}`, 'PATCH', { rpm: 600, tpm: 200000 });
  }
  await admin(token, '/admin/api/clients', 'POST', { name: 'backend', rpm: 600, dailyTokens: 200000, models: [] });
  await admin(token, '/admin/api/clients', 'POST', { name: 'laptop', rpm: 120, dailyTokens: 50000, models: [] });
  return clientKey;
}

function startTraffic(clientKey) {
  trafficOn = true;
  (async () => {
    while (trafficOn) {
      const batch = [];
      const n = 4 + Math.floor(Math.random() * 5);
      for (let i = 0; i < n; i++) {
        const anthropic = Math.random() < 0.3;
        batch.push(
          fetch(HYDRA + (anthropic ? '/v1/messages' : '/v1/chat/completions'), {
            method: 'POST',
            headers: { authorization: 'Bearer ' + clientKey, 'content-type': 'application/json' },
            body: JSON.stringify(
              anthropic
                ? { model: 'claude-3-5-sonnet', max_tokens: 64, messages: [{ role: 'user', content: 'hi ' + i }] }
                : { model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hello ' + i }] }
            )
          }).catch(() => {})
        );
      }
      await Promise.all(batch);
      await new Promise((r) => setTimeout(r, 120 + Math.random() * 320));
    }
  })();
}

async function cdp(ws, method, params = {}) {
  const id = Math.floor(Math.random() * 1e9);
  return new Promise((resolve, reject) => {
    const onMessage = (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
      if (msg.id === id) {
        ws.removeEventListener('message', onMessage);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
      }
    };
    ws.addEventListener('message', onMessage);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const mock = await startMock(9101);
  const token = await login();
  const clientKey = await prepare(token);
  startTraffic(clientKey);

  const chrome = spawn(
    CHROME,
    [
      '--headless=new',
      '--no-sandbox',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      '--user-data-dir=/tmp/hydra-chrome',
      '--hide-scrollbars',
      '--force-device-scale-factor=1',
      '--remote-debugging-port=9333',
      '--window-size=1440,1180',
      'about:blank'
    ],
    { stdio: 'ignore' }
  );

  let version;
  for (let i = 0; i < 80; i++) {
    try {
      version = await fetch('http://127.0.0.1:9333/json/version').then((r) => r.json());
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 150));
    }
  }
  if (!version) throw new Error('chrome did not start');

  const target = await fetch('http://127.0.0.1:9333/json/new?about:blank', { method: 'PUT' }).then((r) => r.json());
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r, { once: true }));

  await cdp(ws, 'Page.enable');
  await cdp(ws, 'Network.enable');
  await cdp(ws, 'Network.setCookie', { name: 'hydra_sid', value: token, domain: '127.0.0.1', path: '/' });
  await cdp(ws, 'Emulation.setDeviceMetricsOverride', { width: 1440, height: 1180, deviceScaleFactor: 1, mobile: false });
  await cdp(ws, 'Page.navigate', { url: HYDRA + '/admin' });
  await new Promise((r) => setTimeout(r, 2000));

  await cdp(ws, 'Runtime.evaluate', {
    expression: `localStorage.setItem('hydra_lang','en'); document.querySelector('#lang-switch button[data-lang="en"]').click()`
  });

  console.log(`warming traffic for ${Math.round(WARMUP_MS / 1000)}s...`);
  await new Promise((r) => setTimeout(r, WARMUP_MS));

  const shot = async (name, view, opts = {}) => {
    if (ONLY.length && !ONLY.includes(name)) return;
    await cdp(ws, 'Runtime.evaluate', { expression: 'window.scrollTo(0,0)' });
    if (view) {
      await cdp(ws, 'Runtime.evaluate', { expression: `document.querySelector('.nav-item[data-view="${view}"]').click()` });
    }
    await new Promise((r) => setTimeout(r, opts.wait || 1200));
    const { data } = await cdp(ws, 'Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    fs.writeFileSync(path.join(OUT, name + '.png'), Buffer.from(data, 'base64'));
    console.log('shot', name);
  };

  await shot('overview', null, { wait: 1600 });
  await shot('keys', 'keys');
  await shot('access', 'access');
  await shot('logs', 'logs');
  await shot('settings', 'settings');

  await cdp(ws, 'Runtime.evaluate', {
    expression: `document.querySelector('.nav-item[data-view="playground"]').click();
      document.querySelector('#play-model').value = 'gpt-4o-mini';
      document.querySelector('#play-prompt').value = 'Explain in two sentences why a key pool beats one API key.';
      document.querySelector('#play-run').click();`
  });
  await new Promise((r) => setTimeout(r, 2500));
  await shot('playground', null, { wait: 600 });
  await shot('analytics', 'analytics');
  await shot('docs', 'docs');

  await cdp(ws, 'Runtime.evaluate', { expression: `document.querySelector('#lang-switch button[data-lang="ru"]').click()` });
  await cdp(ws, 'Runtime.evaluate', { expression: `document.querySelector('.nav-item[data-view="overview"]').click()` });
  await new Promise((r) => setTimeout(r, 900));
  await shot('overview-ru', null, { wait: 500 });
  await cdp(ws, 'Emulation.setDeviceMetricsOverride', { width: 430, height: 940, deviceScaleFactor: 2, mobile: true });
  await new Promise((r) => setTimeout(r, 800));
  await shot('mobile', 'overview', { wait: 900 });

  await cdp(ws, 'Runtime.evaluate', { expression: `document.querySelector('#lang-switch button[data-lang="en"]').click()` });
  await new Promise((r) => setTimeout(r, 400));

  trafficOn = false;
  ws.close();
  chrome.kill('SIGKILL');
  mock.close();
  console.log('done');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});