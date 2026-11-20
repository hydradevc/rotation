import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { load, flush, state } from './src/store.js';
import { handleAdmin, ensurePassword, ensureDefaultClient, isAdminSession } from './src/admin.js';
import { handleProxy, readBody } from './src/proxy.js';
import { poolSnapshot } from './src/pool.js';
import { prometheus } from './src/metrics.js';
import { openapiSpec } from './src/openapi.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');
const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || '0.0.0.0';
const VERSION = '1.2.2';
const MAX_URL = 4096;

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

const CSP = [
  "default-src 'self'",
  "img-src 'self' data:",
  "style-src 'self' 'unsafe-inline'",
  "script-src 'self'",
  "connect-src 'self'",
  "font-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'"
].join('; ');

function requestIsSecure(req) {
  if (req.socket.encrypted) return true;
  const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
  return proto === 'https';
}

function isApiPath(pathname) {
  return (
    pathname.startsWith('/v1/') ||
    pathname.startsWith('/admin/api/') ||
    pathname === '/healthz' ||
    pathname === '/readyz' ||
    pathname === '/metrics' ||
    pathname === '/openapi.json'
  );
}

function applySecurityHeaders(req, res, pathname) {
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('x-frame-options', 'DENY');
  res.setHeader('referrer-policy', 'no-referrer');
  res.setHeader('permissions-policy', 'geolocation=(), microphone=(), camera=(), interest-cohort=()');
  res.setHeader('cross-origin-opener-policy', 'same-origin');
  res.setHeader('cross-origin-resource-policy', 'same-origin');
  res.setHeader('x-hydra-version', VERSION);
  if (!isApiPath(pathname)) res.setHeader('content-security-policy', CSP);
  if (requestIsSecure(req)) {
    res.setHeader('strict-transport-security', 'max-age=31536000; includeSubDomains');
  }
}

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

function metricsAllowed(req) {
  if (state.settings.metricsPublic) return true;
  const token = process.env.HYDRA_METRICS_TOKEN;
  if (token) {
    const header = String(req.headers.authorization || '');
    const expected = crypto.createHash('sha256').update(`Bearer ${token}`).digest();
    const actual = crypto.createHash('sha256').update(header).digest();
    if (crypto.timingSafeEqual(expected, actual)) return true;
  }
  return isAdminSession(req);
}

function writeJson(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload));
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': body.length });
  res.end(body);
}

let ready = false;
let draining = false;

const server = http.createServer(async (req, res) => {
  const startedAt = Date.now();
  const requestId = crypto.randomBytes(8).toString('hex');
  res.setHeader('x-request-id', requestId);

  if (!req.url || req.url.length > MAX_URL) {
    res.writeHead(414, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('uri too long');
    return;
  }

  const url = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
  const pathname = url.pathname;

  applySecurityHeaders(req, res, pathname);

  if (process.env.HYDRA_ACCESS_LOG === 'json') {
    res.on('finish', () => {
      console.log(
        JSON.stringify({
          evt: 'http',
          id: requestId,
          method: req.method,
          path: pathname,
          status: res.statusCode,
          ms: Date.now() - startedAt,
          ip: req.socket.remoteAddress
        })
      );
    });
  }

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
      writeJson(res, 200, {
        ok: true,
        version: VERSION,
        uptime: Math.round(process.uptime())
      });
      return;
    }

    if (pathname === '/readyz') {
      const pool = poolSnapshot();
      const writable = (() => {
        try {
          const dir = process.env.HYDRA_DATA || path.resolve(process.cwd(), 'data');
          fs.accessSync(dir, fs.constants.W_OK);
          return true;
        } catch {
          return false;
        }
      })();
      const ok = ready && !draining && writable && pool.summary.healthy > 0;
      const payload = { ok, ready: ready && !draining };
      if (isAdminSession(req)) {
        payload.writable = writable;
        payload.keys = pool.summary.keys;
        payload.healthy = pool.summary.healthy;
        payload.unreadableSecrets = state.meta?.unreadableKeys || 0;
      }
      writeJson(res, ok ? 200 : 503, payload);
      return;
    }

    if (pathname === '/metrics') {
      if (!metricsAllowed(req)) {
        res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('metrics are protected: set HYDRA_METRICS_TOKEN or enable public metrics in settings');
        return;
      }
      const body = prometheus(poolSnapshot());
      res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4; charset=utf-8' });
      res.end(body);
      return;
    }

    if (pathname === '/openapi.json') {
      writeJson(res, 200, openapiSpec());
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
server.requestTimeout = Number(process.env.HYDRA_REQUEST_TIMEOUT_MS || 120000);
server.maxRequestsPerSocket = Number(process.env.HYDRA_MAX_REQUESTS_PER_SOCKET || 1000);

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
ready = true;

server.listen(PORT, HOST, () => {
  console.log(`HYDRA ${VERSION} listening on http://${HOST}:${PORT}`);
  console.log(`  admin panel    http://localhost:${PORT}/admin`);
  console.log(`  openai base    http://localhost:${PORT}/v1`);
  console.log(`  anthropic base http://localhost:${PORT}`);
  console.log(`  metrics        http://localhost:${PORT}/metrics`);
  console.log(`  upstream keys  ${state.keys.length}`);
  if (state.meta.unreadableKeys) {
    console.log(`  WARNING: ${state.meta.unreadableKeys} secrets cannot be decrypted with the current master key`);
  }
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

let shuttingDown = false;

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  draining = false;
  ready = false;
  console.log(JSON.stringify({ evt: 'shutdown', signal, at: new Date().toISOString() }));
  flush();
  server.close(() => process.exit(0));
  server.closeIdleConnections?.();
  setTimeout(() => {
    server.closeAllConnections?.();
    process.exit(0);
  }, 10000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', (err) => {
  console.error(JSON.stringify({ evt: 'unhandledRejection', error: String(err?.message || err), at: new Date().toISOString() }));
});
process.on('uncaughtException', (err) => {
  console.error(JSON.stringify({ evt: 'uncaughtException', error: String(err?.stack || err), at: new Date().toISOString() }));
  shutdown('uncaughtException');
});