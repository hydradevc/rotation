import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startMock } from './mock-upstream.js';

const KEYS = Number(process.env.KEYS || 100);
const REQUESTS = Number(process.env.REQUESTS || 2000);
const CONCURRENCY = Number(process.env.CONCURRENCY || 64);
const PORT = 9103;
const MOCK = 9104;
const PASS = 'benchpass';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const mock = await startMock(MOCK);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hydra-bench-'));
  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.resolve(import.meta.dirname, '..'),
    env: { ...process.env, PORT: String(PORT), HYDRA_DATA: dataDir, HYDRA_ADMIN_PASSWORD: PASS, MOCK_DELAY: '1' },
    stdio: 'ignore'
  });

  const base = `http://127.0.0.1:${PORT}`;
  for (let i = 0; i < 100; i++) {
    try {
      if (await fetch(base + '/healthz').then((r) => r.ok)) break;
    } catch {
      /* not up yet */
    }
    await sleep(100);
  }

  const login = await fetch(base + '/admin/api/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: PASS })
  });
  const cookie = (login.headers.get('set-cookie') || '').split(';')[0];
  const admin = (p, method = 'GET', body) =>
    fetch(base + p, {
      method,
      headers: { cookie, 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined
    }).then((r) => r.json());

  const state = await admin('/admin/api/state');
  const clientKey = (
    await admin(`/admin/api/clients/${state.clients[0].id}/reveal`, 'POST', {})
  ).key;
  if (!clientKey?.startsWith('hydra_sk_')) throw new Error('could not obtain a client key');

  const lines = Array.from(
    { length: KEYS },
    (_, i) => `k${i} | sk-bench-${String(i).padStart(4, '0')}x | http://127.0.0.1:${MOCK}/v1`
  );
  const bulk = await admin('/admin/api/keys/bulk', 'POST', { text: lines.join('\n') });
  console.log(`keys: ${bulk.created}`);

  const payload = JSON.stringify({
    model: 'gpt-4o-mini',
    messages: [{ role: 'user', content: 'benchmark request payload' }]
  });

  const latencies = new Float64Array(REQUESTS);
  let ok = 0;
  let failed = 0;
  let next = 0;
  let slot = 0;
  const started = Date.now();

  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= REQUESTS) return;
      const t0 = performance.now();
      try {
        const res = await fetch(base + '/v1/chat/completions', {
          method: 'POST',
          headers: { authorization: 'Bearer ' + clientKey, 'content-type': 'application/json' },
          body: payload
        });
        await res.arrayBuffer();
        if (res.status === 200) ok++;
        else failed++;
      } catch {
        failed++;
      }
      latencies[slot++] = performance.now() - t0;
    }
  };

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  const elapsed = (Date.now() - started) / 1000;

  const sorted = Array.from(latencies.slice(0, slot)).sort((a, b) => a - b);
  const pct = (p) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))].toFixed(1);

  console.log(
    JSON.stringify(
      {
        requests: REQUESTS,
        concurrency: CONCURRENCY,
        keys: KEYS,
        ok,
        failed,
        seconds: Number(elapsed.toFixed(2)),
        rps: Math.round(REQUESTS / elapsed),
        p50_ms: pct(50),
        p95_ms: pct(95),
        p99_ms: pct(99)
      },
      null,
      2
    )
  );

  child.kill('SIGTERM');
  mock.close();
  fs.rmSync(dataDir, { recursive: true, force: true });

  if (ok !== REQUESTS || failed !== 0) {
    console.error(`bench failed: ${ok}/${REQUESTS} succeeded, ${failed} failed`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});