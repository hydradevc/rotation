# KEYROTATORBENCH — FINAL REPORT

Generated from 310 executed test cases across 3 projects.

## GLOBAL RANKING

### #1 — HYDRA 1.2.1

- **Final score:** 86.68 / 100 — **Excellent**
- **Pass rate:** 92.7% (63 passed, 5 failed, 4 not applicable)
- **Strongest category:** FAIL (100.0)
- **Weakest category:** MEM (28.5)
- **Performance index:** 92.1 · **Reliability index:** 91.7 · **Security:** 100.0

| category | score |
|---|---|
| PERF | 92.1 |
| ROT | 81.8 |
| FAIL | 100 |
| RATE | 85.7 |
| REL | 83.3 |
| SCALE | 73.7 |
| SEC | 100 |
| MEM | 28.5 |
| API | 85.7 |
| CFG | 100 |
| OBS | 100 |
| DX | 100 |

### #2 — Keymesh 1.0.0

- **Final score:** 85.70 / 100 — **Excellent**
- **Pass rate:** 84.6% (44 passed, 8 failed, 18 not applicable)
- **Strongest category:** PERF (100.0)
- **Weakest category:** MEM (34.6)
- **Performance index:** 100.0 · **Reliability index:** 83.3 · **Security:** 66.7

| category | score |
|---|---|
| PERF | 100 |
| ROT | 100 |
| FAIL | 100 |
| RATE | 100 |
| REL | 66.7 |
| SCALE | 99.4 |
| SEC | 66.7 |
| MEM | 34.6 |
| API | 100 |
| CFG | 100 |
| OBS | 66.7 |
| DX | 66.7 |

### #3 — API Key Rotator

- **Final score:** 67.59 / 100 — **Good**
- **Pass rate:** 66% (33 passed, 17 failed, 13 not applicable)
- **Strongest category:** MEM (100.0)
- **Weakest category:** RATE (0.0)
- **Performance index:** 77.2 · **Reliability index:** 66.7 · **Security:** 45.5

| category | score |
|---|---|
| PERF | 77.2 |
| ROT | 100 |
| FAIL | 50 |
| RATE | 0 |
| REL | 83.3 |
| SCALE | 70.8 |
| SEC | 45.5 |
| MEM | 100 |
| API | 100 |
| CFG | 100 |
| OBS | 66.7 |
| DX | 50 |

## THE WINNER

HYDRA 1.2.1 finishes first with 86.68/100 (Excellent). The margin over second place is 0.98 points.

The gap is narrow enough that the result should be read as a tie broken by
category weighting rather than a decisive dominance.

## ANSWERS TO THE TWELVE QUESTIONS

1. **Highest RPS** — keymesh (hydra: 356.57, keymesh: 408.01, apikeyrotator: 339.96) [req/s]
2. **Lowest P95 latency** — keymesh (hydra: 316.92, keymesh: 289.34, apikeyrotator: 410.3) [ms]
3. **Best P99 latency** — keymesh (hydra: 429.69, keymesh: 424.42, apikeyrotator: 668.18) [ms]
4. **Fewest client-visible 429s under an unknown per-key ceiling** — keymesh (hydra: 1.5, keymesh: 0, apikeyrotator: 97.3) [% leaked]
5. **Best failover category score** — tie (hydra, keymesh) (hydra: 100, keymesh: 100, apikeyrotator: 50) [score]
6. **Fewest errors under concurrency** — tie (hydra, keymesh, apikeyrotator) (hydra: 0, keymesh: 0, apikeyrotator: 0) [error rate]
7. **Lowest memory at 100 keys** — apikeyrotator (hydra: 64972, keymesh: 56952, apikeyrotator: 18560) [RSS kB]
8. **Best throughput at 1000 keys** — apikeyrotator (hydra: 111.82, keymesh: 169.26, apikeyrotator: 172.57) [req/s]
9. **Strongest security category** — hydra (hydra: 100, keymesh: 66.67, apikeyrotator: 45.45) [score]
10. **Best developer experience** — hydra (hydra: 100, keymesh: 66.67, apikeyrotator: 50) [score]

11. **Most production-ready** — HYDRA by the operational surface (health, readiness, metrics, backup/restore, hardened admin); API Key Rotator has the thinnest surface and no authentication on its admin API; Keymesh is a library proxy with no operations surface.
12. **Best overall architecture** — HYDRA: a pool object owning rate windows, cooldowns and circuit state, with the proxy layer stateless on top of it. Keymesh comes second with a clean core (registry/retrier/circuit breaker) but no local rate model.


## CRITICAL FINDINGS

- **HYDRA 1.2.1** · `PERF-hydra-consistency-c1` — expected spread < 15% of median; observed 28.3% spread
- **HYDRA 1.2.1** · `PERF-hydra-consistency-c10` — expected spread < 15% of median; observed 26.2% spread
- **HYDRA 1.2.1** · `ROT-hydra-random-balance` — expected deviation < 35% (stochastic selection); observed 43.3%
- **HYDRA 1.2.1** · `ROT-hydra-smart-balance` — expected deviation < 35% (stochastic selection); observed 46.7%
- **HYDRA 1.2.1** · `RATE-hydra-429-informed` — expected 0 client-visible 429; observed 8 of 140
- **HYDRA 1.2.1** · `REL-hydra-memory-growth` — expected <= 15% RSS growth; observed 55164 kB (62.9%)
- **HYDRA 1.2.1** · `API-hydra-header-forwarding` — expected x-custom-tag reaches upstream; observed 0 hit(s)
- **Keymesh 1.0.0** · `PERF-keymesh-consistency-c10` — expected spread < 15% of median; observed 30.3% spread
- **Keymesh 1.0.0** · `REL-keymesh-memory-growth` — expected <= 15% RSS growth; observed 32732 kB (28.2%)
- **Keymesh 1.0.0** · `REL-keymesh-bad-request-body` — expected 4xx, no crash; observed status 200
- **Keymesh 1.0.0** · `SEC-keymesh-unauth-__keymesh_inspect` — expected 401/403 or no data; observed HTTP 200, 3016 bytes
- **Keymesh 1.0.0** · `SEC-keymesh-default-proxy-key` — expected 401/403; observed HTTP 200
- **Keymesh 1.0.0** · `SEC-keymesh-security-headers` — expected >= 2 of nosniff/frame-options/CSP; observed 0 present: []
- **Keymesh 1.0.0** · `OBS-keymesh-error-visibility` — expected error counters or error log lines; observed error_metric=False
- **Keymesh 1.0.0** · `DX-keymesh-docker` — expected yes; observed Dockerfile=False compose=False
- **Keymesh 1.0.0** · `DX-keymesh-api-spec` — expected yes; observed no spec file
- **API Key Rotator** · `PERF-apikeyrotator-consistency-c10` — expected spread < 15% of median; observed 670.0% spread
- **API Key Rotator** · `PERF-apikeyrotator-consistency-c50` — expected spread < 15% of median; observed 193.6% spread
- **API Key Rotator** · `FAIL-apikeyrotator-single-key` — expected 40/40 HTTP 200; observed 36/40 ok, statuses={'200': 36, '503': 4}
- **API Key Rotator** · `FAIL-apikeyrotator-multi-key` — expected >= 38/40 HTTP 200; observed 28/40 ok
- **API Key Rotator** · `FAIL-apikeyrotator-auth-fail` — expected no 401 leaks to client, key gets disabled; observed 27/30 ok, {'200': 27, '401': 3}
- **API Key Rotator** · `FAIL-apikeyrotator-slow-key` — expected client served from another key; observed 9/10 ok, p95=4015.9ms
- **API Key Rotator** · `RATE-apikeyrotator-429-reactive` — expected <= 5% client-visible 429; observed 3958 of 4068 (97.3%)
- **API Key Rotator** · `RATE-apikeyrotator-retry-after` — expected rotator backs off instead of hammering; observed 1795 429 of 1805 (99.4%)
- **API Key Rotator** · `REL-apikeyrotator-bad-request-body` — expected 4xx, no crash; observed status 200
- **API Key Rotator** · `SEC-apikeyrotator-unauth-admin-proxy-configs` — expected 401/403 or no data; observed HTTP 200, 254 bytes
- **API Key Rotator** · `SEC-apikeyrotator-unauth-admin-proxy-configs-1-keys` — expected 401/403 or no data; observed HTTP 200, 752 bytes
- **API Key Rotator** · `SEC-apikeyrotator-at-rest-plaintext` — expected no plaintext key on disk; observed plaintext key found on disk
- **API Key Rotator** · `SEC-apikeyrotator-logs-leak` — expected no full key in log output; observed 8 keys found
- **API Key Rotator** · `SEC-apikeyrotator-cors` — expected no access-control-allow-origin: *; observed acao=*

## METHOD NOTES (what was worked around, and why)

- Throughput tests import HYDRA keys with `rpm: 1000000` so its own limiter does not
  throttle a comparison the other two products cannot participate in. The limiter is
  restored for `RATE-*-429-informed`, where the capability is the subject.
- HYDRA routes `/v1/messages` to anthropic-provider keys only; the API-compatibility
  test therefore boots it with one anthropic key. Without it the endpoint answers
  503 (measured, see `API-*-anthropic-endpoint` in the earlier run).
- Keymesh has no runtime key API: pool size changes restart the process. That is its
  configuration model, and boot cost is measured, not hidden.
- Keymesh keys are deterministic strings; its `--keys-env` path is used exactly as
  documented.
- Load levels stop at concurrency 100. 500/1000/5000/10000 were **not executed**:
  the harness, the subject and the mock share one container budget, and pushing
  further would measure the generator. They are absent, not failed.
- The soak is 30 s, not 24 h. A 24-hour run is outside this session's budget and is
  not claimed anywhere in this report.
- Docker Compose was not used (no Docker daemon in the container); Docker support is
  scored from the shipped artefacts, not from a live deployment.
- Charts are hand-rendered SVG because matplotlib/numpy cannot be built on this
  musl host; values come from `results/raw_results.json` with no post-processing.

## ADDITIONAL VERIFICATION (outside the suite)

A defect the suite caught only intermittently was reproduced manually and recorded
in `results/manual_repro_header_bug.txt`: a HYDRA key whose label contains a
non-ASCII character makes the response unsendable (`x-hydra-key`). One request out
of ten hung; an earlier attempt returned HTTP 500 `Invalid character in header
content`. The panel's own auto-generated labels use `…`, so the state is reachable
through normal use.

## DELIVERABLES

See `reports/` for every generated document, `charts/` for the SVG charts and
`benchlib/`, `mock/`, `run_all.py`, `score.py`, `charts.py` for the harness.
