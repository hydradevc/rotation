import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { load, flush, state } from './src/store.js';
import { handleAdmin, ensurePassword, ensureDefaultClient } from './src/admin.js';
import { handleProxy, readBody } from './src/proxy.js';
import { poolSnapshot } from './src/pool.js';
import { prometheus } from './src/metrics.js';
import { openapiSpec } from './src/openapi.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');
const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || '0.0.0.0';
const VERSION = '1.1.0';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json'
};

function serveFile(req, res, filePath) {
  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('not found');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    const etag = `"${stat.size.toString(16)}-${stat.mtimeMs.toString(16)}"`;
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, { etag, 'cache-control': 'no-cache' });
      res.end();
      return;
    }
    res.writeHead(200, {
      'content-type': MIME[ext] || 'application/octet-stream',
      'content-length': stat.size,
      etag,
      'cache-control': ext === '.woff2' ? 'public, max-age=31536000, immutable' : 'no-cache'
    });
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    fs.createReadStream(filePath).pipe(res);
  });
}

function safeJoin(root, target) {
  const resolved = path.resolve(root, '.' + target);
  return resolved.startsWith(root) ? resolved : null;
}

function applyCors(req, res) {
  if (!state.settings.cors) return;
  const origin = state.settings.corsOrigin || '*';
  res.setHeader('access-control-allow-origin', origin);
  res.setHeader('access-control-allow-headers', 'authorization, content-type, x-api-key, anthropic-version, anthropic-beta');
  res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
  res.setHeader('access-control-max-age', '86400');
  if (origin !== '*') res.setHeader('vary', 'origin');
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
  const pathname = url.pathname;

  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('referrer-policy', 'same-origin');
  res.setHeader('x-hydra-version', VERSION);

  try {
    if (pathname.startsWith('/v1/')) {
      applyCors(req, res);
      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
      }
    }

    if (pathname === '/healthz') {
      const pool = poolSnapshot();
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          ok: true,
          version: VERSION,
          keys: state.keys.length,
          healthy: pool.summary.healthy,
          uptime: Math.round(process.uptime())
        })
      );
      return;
    }

    if (pathname === '/metrics') {
      const body = prometheus(poolSnapshot());
      res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4; charset=utf-8' });
      res.end(body);
      return;
    }

    if (pathname === '/openapi.json') {
      const body = Buffer.from(JSON.stringify(openapiSpec(), null, 2));
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'content-length': body.length });
      res.end(body);
      return;
    }

    if (pathname.startsWith('/admin/api/')) {
      const body = req.method === 'POST' || req.method === 'PATCH' ? await readBody(req) : Buffer.alloc(0);
      await handleAdmin(req, res, url, body);
      return;
    }

    if (pathname.startsWith('/v1/')) {
      const body = req.method === 'GET' ? Buffer.alloc(0) : await readBody(req);
      await handleProxy(req, res, url, body);
      return;
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('method not allowed');
      return;
    }

    if (pathname === '/' || pathname === '/admin' || pathname === '/admin/') {
      serveFile(req, res, path.join(PUBLIC_DIR, 'index.html'));
      return;
    }

    const candidate = safeJoin(PUBLIC_DIR, pathname);
    if (!candidate) {
      res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('forbidden');
      return;
    }
    serveFile(req, res, candidate);
  } catch (err) {
    if (!res.headersSent) {
      res.writeHead(err.status || 500, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: err.message }));
    } else {
      res.end();
    }
  }
});

server.keepAliveTimeout = 65000;
server.headersTimeout = 66000;
server.requestTimeout = 0;

load();
const generated = ensurePassword((password) => {
  console.log('');
  console.log('  ┌─────────────────────────────────────────────┐');
  console.log('  │  HYDRA admin password (save it now)         │');
  console.log('  │  ' + password.padEnd(43) + '│');
  console.log('  └─────────────────────────────────────────────┘');
  console.log('');
});
const defaultClient = ensureDefaultClient();

server.listen(PORT, HOST, () => {
  console.log(`HYDRA ${VERSION} listening on http://${HOST}:${PORT}`);
  console.log(`  admin panel    http://localhost:${PORT}/admin`);
  console.log(`  openai base    http://localhost:${PORT}/v1`);
  console.log(`  anthropic base http://localhost:${PORT}`);
  console.log(`  metrics        http://localhost:${PORT}/metrics`);
  console.log(`  upstream keys  ${state.keys.length}`);
  if (defaultClient) {
    console.log('');
    console.log('  Default access key created:');
    console.log('  ' + defaultClient.key);
    console.log('  Keep it secret — it is the key your apps use.');
    console.log('');
  }
  if (generated === null && !process.env.HYDRA_ADMIN_PASSWORD) {
    console.log('  (admin password already set — stored as scrypt hash in data/state.json)');
  }
});

function shutdown() {
  flush();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);