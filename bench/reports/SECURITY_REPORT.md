# SECURITY REPORT

Authorized, non-destructive checks executed against locally deployed instances
talking to a local mock upstream. No external system was touched.

## HYDRA 1.2.1

Passed 13, failed 0, not applicable 0.

| check | expected | observed | result |
|---|---|---|---|
| Unauthenticated GET /admin/api/state | 401/403 or no data | HTTP 401, 24 bytes | pass |
| Unauthenticated GET /admin/api/logs | 401/403 or no data | HTTP 401, 24 bytes | pass |
| Unauthenticated GET /admin/api/export | 401/403 or no data | HTTP 401, 24 bytes | pass |
| Admin payload contains raw upstream keys | keys masked or encrypted | 0 raw keys visible | pass |
| Upstream keys are not stored in plaintext | no plaintext key on disk | no plaintext key on disk | pass |
| Full upstream keys never appear in logs | no full key in log output | none found | pass |
| Metrics endpoint is access controlled | 401/403/404 without credentials | HTTP 403 | pass |
| Documented default proxy key is rejected | 401/403 | HTTP 401 | pass |
| No wildcard CORS on the API | no access-control-allow-origin: * | acao=None | pass |
| Error responses do not leak internals | no stack traces or file paths | HTTP 400: {"error":{"message":"model is required","type":"invalid_request_error","code":400}} | pass |
| Security headers on the HTTP surface | >= 2 of nosniff/frame-options/CSP | 3 present: ['x-content-type-options', 'x-frame-options', 'content-security-policy'] | pass |
| Dependency audit | 0 high/critical in production deps | 0 production vulnerabilities over 0 deps | pass |
| Non-ASCII key label does not break responses | 200 | HTTP 200: b'{"id": "chatcmpl-bench", "object": "chat.completion", "created": 1795185010, "mo' | pass |

## Keymesh 1.0.0

Passed 6, failed 3, not applicable 2.

| check | expected | observed | result |
|---|---|---|---|
| Unauthenticated GET /__keymesh_inspect | 401/403 or no data | HTTP 200, 3016 bytes | fail |
| Admin payload contains raw upstream keys | keys masked or encrypted | 0 raw keys visible | pass |
| Upstream keys are not stored in plaintext | no plaintext key on disk | no plaintext key on disk | pass |
| Full upstream keys never appear in logs | no full key in log output | none found | pass |
| Metrics endpoint is access controlled | n/a - no metrics endpoint | no metrics surface | n/a |
| Documented default proxy key is rejected | 401/403 | HTTP 200 | fail |
| No wildcard CORS on the API | no access-control-allow-origin: * | acao=None | pass |
| Error responses do not leak internals | no stack traces or file paths | HTTP 200: {"id":"chatcmpl-bench","object":"chat.completion","created":1795184735,"model":"bench-model","choices":[{"index":0,"mess | pass |
| Security headers on the HTTP surface | >= 2 of nosniff/frame-options/CSP | 0 present: [] | fail |
| Dependency audit | 0 high/critical in production deps | 0 production vulnerabilities over 0 deps | pass |
| Non-ASCII key label does not break responses | not applicable (no key labels exposed as headers) | n/a | n/a |

## API Key Rotator

Passed 5, failed 6, not applicable 2.

| check | expected | observed | result |
|---|---|---|---|
| Unauthenticated GET /admin/proxy-configs | 401/403 or no data | HTTP 200, 254 bytes | fail |
| Unauthenticated GET /admin/app-config | 401/403 or no data | HTTP 200, 49 bytes | pass |
| Unauthenticated GET /admin/proxy-configs/1/keys | 401/403 or no data | HTTP 200, 752 bytes | fail |
| Admin payload contains raw upstream keys | keys masked or encrypted | 0 raw keys visible | pass |
| Upstream keys are not stored in plaintext | no plaintext key on disk | plaintext key found on disk | fail |
| Full upstream keys never appear in logs | no full key in log output | 8 keys found | fail |
| Metrics endpoint is access controlled | 401/403/404 without credentials | HTTP 404 | pass |
| Documented default proxy key is rejected | 401/403 | HTTP 400 | pass |
| No wildcard CORS on the API | no access-control-allow-origin: * | acao=* | fail |
| Error responses do not leak internals | no stack traces or file paths | HTTP 404: 404 page not found
 | pass |
| Security headers on the HTTP surface | >= 2 of nosniff/frame-options/CSP | 1 present: ['x-content-type-options'] | fail |
| Dependency audit | Go module audit | govulncheck not executed (toolchain offline) | n/a |
| Non-ASCII key label does not break responses | not applicable (no key labels exposed as headers) | n/a | n/a |

## Notes

- Secrets at rest were checked by scanning the project's own state file / SQLite
  database for a literal upstream key after import.
- Log leakage was checked by grepping the captured stdout/stderr of the service.
- Dependency audit: `npm audit --omit=dev` for the Node projects; the Go project
  was not audited with govulncheck because the toolchain is not present in this
  environment (recorded as not executed, not as a pass).
- No brute force, fuzzing or destructive test was performed.
