# Changelog

## 1.1.0 - 2026-11-19

Specification-compliance release. Several changes tighten unsafe behavior; review the migration notes before upgrading a palette.

Security and behavior fixes:

- KIT-SEC-6: managed input, startup, track, close, and HTTP operations now take a redaction snapshot at start. A password released by a config node while a consumer operation is in flight is still masked in `done(err)`, `msg.error`, logs, and HTTP responses. Late settlements are logged only as `LATE_OPERATION_COMPLETED`/`LATE_OPERATION_FAILED` with an operation ID.
- KIT-HTTP-6: an internal listener can no longer mix `auth: 'local'` and token routes. This reverts the 1.0.1 change. Migration: give every route on an exposed (token) listener its own token, or keep loopback-only routes on a separate local-only palette listener.
- KIT-AUTH-4: without `adminAuth`, admin routes are registered and answer 503 `ADMIN_AUTH_REQUIRED` instead of being absent (404). The missing-adminAuth and admin-disabled reasons are each logged once per context.
- KIT-HTTP-7: an acquire that arrives while the last lease is closing the internal listener now waits for the close instead of racing it; the releasing node no longer hangs until its close deadline.
- KIT-HTTP-4: an admin handler that throws AbortError while the client is still connected now gets a controlled 500 instead of no response.
- KIT-AUTH-3: `requireSecret` treats an unexpanded `${VAR}` placeholder as a missing secret.
- KIT-LOG-5: closing, invalid configuration/disabled palette, permanent startup failure, internal-server failure, starting, and the errorOutput counter are now prioritized overlays; `k.status()` no longer hides them.
- KIT-MET-1: a node can release and reacquire its metrics lease.
- Nodes with invalid configuration can no longer acquire metrics or internal-server leases.
- KIT-RDS-3/4/5: a blocking connection with a finite `commandTimeout` requires a finite `blockMs` (BLOCK 0 is rejected); subscribers reject `commandTimeout`; TLS clusters resolve startup hostnames without converting them to IPs (`dnsLookup` passthrough); reconnect strategies use exponential backoff with jitter; unknown options, URL-style hosts, `checkServerIdentity` overrides, and connection names with whitespace or control characters are rejected.
- KIT-SEC-5: field-name masking now covers `x-api-key`, `proxy-authorization`, `credentials`, and any field ending in password, passphrase, token, secret, apiKey, privateKey, authorization, or cookie.

Contract corrections:

- `classifyError` returns `stop` for AbortError (was `abort`), as the specification defines.
- KIT-CFG-2: schemas reject unknown options, `min`/`max` on bool/enum, `values` on non-enum fields, and non-boolean `required`; `bool` accepts only booleans, 0/1, and strings.
- KIT-CFG-8: palette parameters cannot redeclare automatic `<secret>Token` parameters; `init` rejects unknown options.
- KIT-CFG-7: `disabledReason` for an invalid enabled value has the `{ code, message, issues }` shape.
- KIT-HTTP-12: admin and internal routes accept a per-route `handlerTimeoutMs`; late facade writes after a timeout are ignored.
- KIT-RES-1/RES-3: `backoff` no longer returns NaN for `initial: 0` or after exponent overflow; `retry` keeps the original error as `cause` when `retryOn` throws and tolerates `null` rejections; `track` tolerates empty rejections.
- errorOutput keeps a sanitized message for non-Error throws instead of a generic text.

## 1.0.1 - 2026-10-09

- Allow loopback-only and token-authenticated internal routes to share one listener; local authorization always checks the peer socket address.

## 1.0.0 - 2026-10-07

- Add auth primitives and fail-closed admin route registry.
- Add reference-counted Prometheus text 0.0.4 metrics source registration and discovery.
- Add standalone/cluster Redis client factory APIs without a runtime ioredis dependency.
- Add Node-RED 4.1/5 runtime and credential-redaction integration tests.
- Add immutable runtime state checks, Node-RED status recovery overlays, and Redis reconnect/cluster failover handling.
- Add a six-node TLS Redis Cluster and Toxiproxy release integration gate.
- Add pinned CI/release workflows, pack/requirement checks, and consumer declaration tests.
- Tighten startup/input deadlines, close draining, and secret redaction.

## 1.0.0-alpha.1 - 2026-10-06

- Add domain naming and instance identity helpers.
- Add typed config parsing and namespaced environment/settings readers.
- Add backoff, retry, timeout, abortable sleep, and bounded concurrency helpers.
- Add palette, node, and plugin contexts with logging, status, input handling, and lifecycle management.