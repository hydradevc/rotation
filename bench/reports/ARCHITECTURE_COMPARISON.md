# ARCHITECTURE COMPARISON

Everything below was read from the source at the pinned commits; runtime claims are
marked separately from code facts.

| | HYDRA 1.2.1 | API Key Rotator (Go) | Keymesh 1.0.0 |
|---|---|---|---|
| Commit | `a2a16f0` | `2ece265` | `19fec5b` |
| Language | Node.js ≥ 20, ESM, zero dependencies | Go 1.21 + Gin + GORM, Vue 3 UI | TypeScript, library + CLI proxy |
| Size | ~3.4k LOC (`server.js`, `src/*.js`) | ~2.7k LOC backend + Vue frontend | ~2.2k LOC `src/`, 21 test files |
| Deployment | `node server.js`, Dockerfile + compose | Docker + compose (SQLite or MySQL + Redis), needs a build | `npm i && npm run build`, then `keymesh start` |
| State | `data/state.json`, atomic write | SQLite (default) or MySQL | In-memory, optional JSONL file backend |
| Secret storage | AES-256-GCM sealed, master key from env or generated (`src/crypto.js`) | **Plaintext** in `api_keys.key_value` | Plaintext in memory / JSONL |
| Admin auth | scrypt password, HttpOnly session cookie, same-origin check on writes, 10 login attempts/min (`src/admin.js:376-406`) | `POST /admin/login` returns success **without issuing a token**; no middleware guards `/admin/*` (`internal/handlers/management.go:39`) | No admin surface at all |
| Selection policies | smart (load-aware sampling), round-robin, random, weighted (`src/pool.js:130-200`) | round-robin only, via cache `INCR` (`internal/services/proxy_handler.go:47`) | round-robin, weighted, least-used, sequential-then-rotate (`src/strategies/`) |
| Rate-limit model | per-key RPM + TPM in a rolling 60 s bucket array, reserved before the call (`src/pool.js:12-73`) | none | none |
| 429 handling | retry on another key, `Retry-After` / `x-ratelimit-reset-*` aware down to a cooldown timer | none — the 429 is returned to the client | retry with rotation (`src/core/Retrier.ts`) |
| Circuit breaker | per-key failure count, threshold 4, 120 s park, auto-probe (`src/pool.js:100-120`) | none | `src/core/CircuitBreaker.ts` with state machine + half-open probe |
| Failover scope | request replayed on the next key until `maxAttempts` (default 8) or `deadlineMs` (120 s) | no replay | retry loop in `Retrier` with key exclusion |
| Streaming | native SSE pipe, cross-format stream translation (`src/translate.js`) | stream pass-through with optional format conversion | transparent pass-through |
| Metrics | Prometheus `/metrics` (token-protected), `/healthz`, `/readyz`, `/openapi.json` | none (`/metrics` → 404) | `inspect()` snapshot over `/__keymesh_inspect` |
| Backup | `GET /admin/api/export`, `POST /admin/api/import` | none | state file only |
| Docker | Dockerfile + compose, `read_only`, `cap_drop: ALL`, healthcheck on `/readyz` | Dockerfile + compose (healthcheck points at `/health`, which the router does not define) | none |

## Request path

**HYDRA** — `server.js` routes `/v1/*` to `handleProxy` (`src/proxy.js`), which picks a key
from the pool (`src/pool.js`), reserves RPM/TPM, calls the upstream with `fetch`, and on a
retryable status penalises the key (cooldown or circuit park) and tries the next one.

**API Key Rotator** — `router.go` maps `/llm/:slug/*action` to `LLMProxyHandler`, which loads
the config with its keys from GORM, asks the cache for the next index (`INCR`), rewrites the
`Authorization` header with the selected key, forwards once, and returns the upstream status
unchanged. There is no retry, no cooldown, no per-key state.

**Keymesh** — the CLI builds a `createKeymesh()` client around an adapter; every inbound HTTP
request is turned into an adapter call that runs through the strategy, the retrier and the
circuit breaker. It is a proxy wrapper around a library, so the whole failover logic lives in
`src/core/`.

## Consequences visible in the measurements

- HYDRA carries the most machinery per request (pool bookkeeping, sealing, metrics,
  reservation) and pays for it in single-connection latency, but it is the only project that
  keeps a request alive across upstream failures without help from the caller.
- API Key Rotator is the thinnest path: one DB read, one cache `INCR`, one forward. It is
  fast per request but has nothing to fall back on when a key dies.
- Keymesh sits in between: a real circuit breaker and retrier, but no local rate model, no
  persistence policy beyond an optional JSONL file, and no operational surface beyond a
  debug snapshot.