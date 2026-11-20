# RECOMMENDATIONS

Ordered by measured impact. Every item cites the test id that produced it
(`reports/TEST_CASES.json` holds the raw record).

## HYDRA 1.2.1 — first place, 86.68, but three defects are worth fixing before production

1. **Response header injection through key labels (release blocker).**
   `x-hydra-key` is set to the raw label (`src/proxy.js:310,665,678`). A label with a
   non-ASCII character — which is exactly what the panel generates, e.g. `sk-ben…0000` —
   makes Node throw on the header. Observed: 1 hung request out of 10, earlier a plain
   `500 {"error":"Invalid character in header content"}`. Evidence:
   `results/manual_repro_header_bug.txt`.
   Fix: sanitise before writing (strip to `[\x20-\x7e]`, or send the key id instead).

2. **Memory grows during load** — `REL-*-memory-growth`: +55 MB (62.9%) over a 30 s soak at
   concurrency 20, and 159 MB RSS at peak concurrency. The log ring and metrics series are
   the first suspects; a bounded, size-capped structure would keep RSS flat.

3. **Throughput variance at low concurrency** — `PERF-*-consistency-c1/c10`: 28% / 26%
   spread between three identical runs. Pricing sampling plus the per-request state flush
   are the likely cause; batching the flush would steady it.

4. **429 boundary leaks and queue-then-503** — `RATE-*-429-informed`: 8 of 140 requests
   reached the client as 429 even though the pool was told the exact per-key ceiling, and a
   further 22 were parked for the 5 s queue window and then answered 503. The local rolling
   window and the provider's fixed window disagree at the boundary; reserving one extra slot
   per window closes most of the 429 gap, and the 503s are the documented "queue instead of
   fail" behaviour under saturation rather than a defect.

5. **Custom request headers are dropped** — `API-*-header-forwarding`: `x-custom-tag` never
   reached the upstream. Anything a provider needs outside the modelled set is lost.

6. **Load-aware strategies skew** — `ROT-*-smart-balance` 46.7%, `ROT-*-random-balance` 43.3%
   deviation across 300 requests. `pickSmart` samples only `sampleSize` keys
   (`src/pool.js:150-186`), so a cold pool concentrates on the first few. Seeding the sample
   with the full pool for the first N requests would remove the warm-up skew.

## Keymesh 1.0.0 — second, 85.70; the cleanest core, the thinnest product

1. **No authentication of any kind.** `SEC-*-default-proxy-key` returned 200 for
   `Bearer your-global-proxy-key`; the proxy accepts any client and burns the pool. A shared
   secret plus a per-client ceiling is the minimum for a deployed proxy.

2. **Debug snapshot is public** — `SEC-*-unauth-__keymesh_inspect` returns 3 KB of key state
   (health scores, cooldowns, counters) to anyone who asks.

3. **Missing HTTP security headers** — `SEC-*-security-headers`: none of nosniff,
   frame-options or CSP is sent.

4. **No operations surface** — `OBS-*-metrics-*` not applicable: no `/metrics`, no `/health`,
   no error counters. `Telemetry` exists as a library hook; nothing exports it over HTTP.

5. **Memory grows with traffic** — `REL-*-memory-growth`: +32 MB (28.2%) over 30 s.

6. **No input validation** — `REL-*-bad-request-body`: malformed JSON is forwarded upstream
   and the upstream 200 is returned unchanged.

7. **No container, no API spec** — `DX-*-docker`, `DX-*-api-spec`.

8. **State is memory-only unless `--state-file` is passed** — `CFG-*-persistence` is
   recorded as not implemented: a restart forgets every health score and cooldown. Fine for a
   library, a surprise for a proxy.

## API Key Rotator — third, 67.59; fast and small, but not a rotator yet in the failure sense

1. **Admin API is unauthenticated (critical).** `SEC-*-unauth-admin-proxy-configs` and
   `.../keys` both return 200 with key material to an anonymous request. `POST /admin/login`
   returns success without issuing a token (`internal/handlers/management.go:39`), and no
   middleware guards `/admin`. Anyone who can reach the port can read every upstream key.

2. **Keys are stored and logged in plaintext.** `SEC-*-at-rest-plaintext` (SQLite) and
   `SEC-*-logs-leak`: GORM debug logging writes `INSERT INTO api_keys ... VALUES ("sk-bench-00000",...)`
   for every imported key, so the full pool sits in the service log (150 occurrences of the
   first three keys alone).

3. **No failover.** `FAIL-*-single-key` 36/40, `FAIL-*-multi-key` 28/40, `FAIL-*-auth-fail`
   27/30: the 4xx/5xx of one key is handed straight to the client. `RotateAPIKey`
   (`internal/services/proxy_handler.go:47`) has no retry path at all.

4. **No rate-limit management.** `RATE-*-429-reactive` 97.3% of requests returned 429;
   `RATE-*-retry-after` 99.4%. There is no RPM/TPM model and no `Retry-After` handling.

5. **Wildcard CORS** — `SEC-*-cors`: `access-control-allow-origin: *` on an API that exposes
   key management.

6. **Pool initialisation is O(n²) over the network.** `SCALE-*-boot-1000`: 19.5 s to import
   1 000 keys through `POST /admin/proxy-configs/:id/keys/batch`, because each key runs a
   `SELECT ... WHERE key_value = ?` before insert. A single `INSERT OR IGNORE` batch fixes it.

7. **Throughput is unstable under concurrency** — `PERF-*-consistency-c10` 670% spread
   between three runs (one run produced several times the requests of another). Suspects:
   SQLite writer serialisation per request and Gin debug logging to disk.

8. **No health or metrics endpoint** — the documented Docker healthcheck targets `/health`,
   which the router does not define (`internal/router/router.go`); `GET /health` fell through
   to the SPA handler and returned 404 in this container.

9. **No tests, no OpenAPI, no one-command start** — `DX-*-tests`, `DX-*-api-spec`,
   `DX-*-install-one-command`.

## Order of work, if the goal is a production rotator

1. Fix HYDRA's header bug — it is a one-line sanitisation with an outage behind it.
2. Harden API Key Rotator's admin surface before it is exposed anywhere.
3. Give Keymesh an auth layer and an operations endpoint before running it as a service.
4. Re-run this harness after the fixes: the same 310 records are the regression baseline.