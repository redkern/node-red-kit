# @redkern/node-red-kit Specification

Revision: 2026-10-06. This revision replaces the 2026-10-05 text. Normative Node-RED integration sources are listed in [standard.md](standard.md) and linked from [README.md](../README.md). This file is the requirement-ID source consumed by `check-req-ids`; implementation status is recorded separately in `verification.json`.

## 1. Purpose and boundaries

The kit is a CommonJS runtime library for independent redkern palettes. It has zero runtime, optional, and peer dependencies; no `node-red` package metadata/keyword; no registered node types, editor resources, frontend bundle, global mutable state, process listeners, or private Node-RED/Express API use. Palettes pass their own `RED` object and required drivers such as ioredis.

Runtime constructors call `RED.nodes.createNode(this, config)` before `rk.bind(this)`. Input handlers use the supplied `send`, preserve unrelated message fields, and delegate exactly-once native `done` to kit. The editor remains palette-owned. Test fixtures use the real Node-RED runtime and `node-red-node-test-helper`; mocks alone do not establish runtime compatibility.

## 2. Public API and architecture

`init(RED, options)` creates palette state without I/O. `rk.bind(node)` creates one node context per initialized runtime node; duplicate bind is rejected. `rk.plugin({ id })` returns a long-lived plugin context without node status, input, startup, close, or node-owned resource APIs. Module state is limited to pure functions/classes/immutable constants. Independently loaded package copies do not share closures.

The root export contains `init`, `names`, `instanceId`, `parseConfig`, `readEnv`, `readSettings`, `secureCompare`, `extractToken`, `requireSecret`, `backoff`, `sleep`, `retry`, `withTimeout`, `createLimiter`, `classifyError`, `ConfigError`, and `PublicError`. The `./redis` subpath contains `createRedisClient`, `classifyRedisError`, `defineScripts`, and `hashTag`. `exports` also exposes `./package.json`; deep imports are unsupported. Types are generated from JSDoc and committed; consumer fixtures cover `node10`, `node16`, and `nodenext` resolution.

The normative contexts are:

```js
const rk = kit.init(RED, {
	domain: 'redis', settingsType: 'redkern-redis-config', params: {},
	enabledByDefault: true, redact: [], secrets: {}, metrics: undefined,
	internalServer: undefined
});

const k = rk.bind(node);
```

`rk` provides `names`, `config`, `enabled`, `disabledReason`, `bind(node)`, `plugin({ id })`, and `createRouteRegistry(route)`. `k` provides `configure`, `readSecret`, `requireSecret`, `secret`, `log`, `status`, `track`, `signal`, `onStart`, `onInput`, `onClose`, `metrics`, and `internalServer`. Optional services are `undefined` when not configured. Unsupported future-stage services/options fail explicitly; no silent no-op APIs.

## 3. Naming

- KIT-NAME-1. `names(domain)` is pure and returns a frozen object with `typePrefix`, `category`, `routeBase`, `permRead`, `permWrite`, `permData`, `envPrefix`, `logPrefix`, and `cssPrefix`. It does not return `settingsKey`.
- KIT-NAME-2. Domain matches `^[a-z]{2,16}$`; runtime has no domain/port registry. Defaults are palette-owned and the registry table lives in `standard.md`. [review]
- KIT-NAME-3. Kit does not rename data identifiers or migrate existing Redis/Kafka/message schemas. [review]
- KIT-NAME-4. `instanceId()` returns `os.hostname()` and never reads `HOSTNAME`. Any palette migration that changes stored IDs explicitly compares old and new IDs; see the palette checklist.

## 4.1. Architecture

- KIT-ARCH-1. No module-level mutable runtime state, caches, registries, or shared keys.
- KIT-ARCH-2. State is owned by init/factories and explicitly passed through closures.
- KIT-ARCH-3. No global/process listeners or writes; `process.env` is read only by `readEnv`. [lint]
- KIT-ARCH-4. Integrations use documented public Node-RED/Node.js/Express APIs; no private runtime fields or direct `@node-red/*` imports. [lint]
- KIT-ARCH-5. Exact TypeScript version; declarations are generated from JSDoc and checked with `checkJs`. [CI]
- KIT-ARCH-6. `exports` exposes only `.`, `./redis`, and `./package.json`; internal deep imports fail.
- KIT-ARCH-7. No kit runtime/optional/peer dependencies; Node-RED is dev-only. [CI]
- KIT-ARCH-8. Init configures palette state; bind configures one node and rejects duplicate binding.
- KIT-ARCH-9. Plugin context has no node-owned lifecycle/resources and no automatic shutdown event. [review]
- KIT-ARCH-10. Independently loaded kit copies share no closures or secret owners; versioned metrics events are explicit interop.

## 4. Config and environment

- KIT-CFG-1. `parseConfig(config, schema)` is pure and returns `{ ok: true, value }` or `{ ok: false, errors }`; invalid results contain no partial value. Issues are `{ field, code, message }` and never echo actual values. `k.configure` is one-shot and runs before startup/input.
- KIT-CFG-2. Types are `int`, `float`, `bool`, `str`, `list`, `enum`; schema options are `default`, `min`, `max`, `required`, `values`. Invalid schemas/defaults throw synchronously. Integers are safe integers; numeric strings must be complete decimal values; booleans accept true/false/0/1; strings do not coerce; lists preserve order/duplicates and reject empty elements; enum matching is exact. Bounds are inclusive and apply to numeric values, Unicode code points, or list length.
- KIT-CFG-3. Absent/null/empty fields use defaults. Explicit `0`, `false`, and `[]` remain values. Required empty values/defaults are rejected; inputs are not mutated.
- KIT-CFG-4. Any invalid configured field blocks I/O. Invalid node config blocks input even without `onStart`; config/start failures complete inputs with `NODE_START_FAILED`.
- KIT-CFG-5. Flow config is never overwritten by kit env/settings lookup or re-expanded by `process.env`. A remaining whole-property Node-RED `${NAME}` or `${$parent.NAME}` placeholder is an error; partial literal strings remain literal. TypedInput env evaluation belongs to the palette and uses public `RED.util.evaluateNodeProperty`.
- KIT-CFG-6. `readEnv(name)` accepts a complete `REDKERN_*` name. `readSettings(RED, settingsType, schema)` reads only allowlisted properties named with the Node-RED type-prefixed camelCase convention. Plugin-only contexts have no settings fallback; secrets are never exportable to editor settings.
- KIT-CFG-7. `enabled` priority is non-empty domain env, non-empty custom setting, then `enabledByDefault`. Accepted values are true/false/1/0, case-insensitive. False disables I/O and completes inputs quietly; malformed input disables I/O and reports `PALETTE_DISABLED_INVALID` through native Catch semantics.
- KIT-CFG-8. Palette parameter names are lowerCamelCase, map unambiguously to `REDKERN_<DOMAIN>_<UPPER_SNAKE_CASE>`, and cannot redeclare reserved fields. [lint]
- KIT-CFG-9. Disabled palettes need not validate runtime values, but schema structure is always checked. Enabled palettes with invalid params/secrets fail closed before I/O; settings/env changes require runtime restart.

## 5. Secrets and auth

- KIT-SEC-1. `k.readSecret(field, { legacyConfig } = {})` reads runtime credentials after `createNode`, registers values before logging, and returns string/undefined. Palette editor and runtime credential definitions must match; see the palette checklist.
- KIT-SEC-2. Legacy fallback is opt-in and applies only when the credential property is absent, never when explicitly cleared. Warn once per node; migrate may use an explicit marker where the runtime normalizes absence/empty.
- KIT-SEC-3. `k.secret(value)` returns idempotent release; close releases automatically. Palette-level value leases are refcounted. Redaction covers all secret lengths, encoded URL representations, configured field names, nested arrays/objects, Error message/stack/cause and cycles without mutating input.
- KIT-SEC-4. Kit does not migrate historical secrets. If a palette migration moves secrets out of flows or Git history, the palette must rotate them and handle repository/backup history. [palette migration]
- KIT-SEC-5. Diagnostics pass through kit sanitization. Direct console/raw-response logging and arbitrary payload contents are outside the guarantee and prohibited for secret-bearing values. [review]
- KIT-SEC-6. Managed operations use a redaction snapshot; late operations log only fixed codes/operation IDs and do not retain secret snapshots indefinitely.
- KIT-SEC-7. `init({ secrets })` reads only domain env tokens or private custom settings; required internal tokens are 32-4096 printable ASCII characters without whitespace, have no default, are not exported to editor, and are unique across route classes.
- KIT-AUTH-1. `secureCompare` accepts non-empty strings only and HMACs both with fresh random key per call before `timingSafeEqual`.
- KIT-AUTH-2. `extractToken` accepts an unambiguous Bearer header or `x-api-key`, never query parameters; repeated/combined headers and tokens over 4096 bytes fail closed.
- KIT-AUTH-3. `requireSecret(k, value, label)` returns boolean and adds permanent `SECRET_REQUIRED` config issue before I/O.
- KIT-AUTH-4. Admin write methods require JSON with UTF-8; without `adminAuth`, kit admin routes fail closed. [CI]
- KIT-AUTH-5. Read/write/data permissions are distinct; data access never follows implicitly from read/write. [CI]

## 6. HTTP and service leases

- KIT-HTTP-1. Admin route registry uses `RED.httpAdmin`, `RED.auth.needsPermission`, domain `routeBase`, static suffix paths, and one registration per runtime closure. Disabled admin API does not create another listener.
- KIT-HTTP-2. Registry exposes `add/remove/size/available`; duplicate IDs fail, removal is idempotent, handlers receive immutable active-entry snapshots.
- KIT-HTTP-3. No global route registry or private middleware removal. No active entries means 503; redeploy does not construct a new `rk`.
- KIT-HTTP-4. `PublicError` is 400-499 and returns sanitized public fields; unknown errors become 500 with a request ID and sanitized logs.
- KIT-HTTP-5. Admin limits are configured through Node-RED `apiMaxLength`; internal body and header/request/concurrency limits are explicit.
- KIT-HTTP-6. Internal routes require explicit local or named-token auth. Local checks exact loopback addresses only. Mixed local/token listeners are forbidden.
- KIT-HTTP-7. `acquire` returns `{ ready, release }`; ownership is per-rk, leases release on close, listen/close races are serialized, and last release drains then closes connections.
- KIT-HTTP-8. Listen failures surface status/log and retry while owners exist; successful retry removes only the service error overlay.
- KIT-HTTP-9. Palette deployment preStop must await drain and fail on unexpected refusal/timeout; it cannot treat every ECONNREFUSED as success. [palette deployment]
- KIT-HTTP-10. Kit never registers on `RED.httpNode`.
- KIT-HTTP-11. Admin/internal handlers share a sanitized response facade, exact routing and normalized request contract.
- KIT-HTTP-12. Handler timeout/disconnect abort request signal; late results cannot write another response.

## 7. Resilience, async, logging, lifecycle

- KIT-RES-1. `backoff` supports full/equal/fractional jitter with finite validation and hard max.
- KIT-RES-2. `sleep` removes timer/listener and rejects with `AbortError` on signal abort.
- KIT-RES-3. `retry(fn, options)` calls `fn({ attempt, signal })`; retry requires explicit `retryOn`, abort is never retried.
- KIT-RES-4. `withTimeout` clears timers/listeners and consumes late rejection; timeout does not claim to cancel I/O.
- KIT-RES-5. Limiter requires concurrency/maxQueue and provides FIFO `run`, `close`, `stats`; overflow is `LIMITER_QUEUE_FULL`, queued aborts reject, active tasks retain slots until settle.
- KIT-ASYNC-1. `track` returns boolean, catches rejection, respects close, ignores expected AbortError status changes.
- KIT-ASYNC-2. `onInput(handler, options)` requires concurrency; handler receives `(msg, send)`, kit owns exactly-once native done. Startup queue has bounded capacity and message-arrival deadlines.
- KIT-ASYNC-3. Unit/integration run with strict unhandled rejection; late rejection tests use child processes. [CI]
- KIT-ASYNC-4. Native input send/done and message identity/properties follow Node-RED semantics; no Node-RED 0.x support.
- KIT-ASYNC-5. Guarded send after completion/timeout/close is ignored and diagnosed; close drains queued/active work against one deadline.
- KIT-ASYNC-6. Palette source nodes use `node.send`; EventEmitter errors are handled; payload type behavior is palette-documented. [palette]
- KIT-LOG-1. Logger redacts before Node-RED logging, deduplicates only explicit keys/codes, emits trailing suppression summaries, and bounds its LRU at 256.
- KIT-LOG-2. Logs carry domain/node or explicit plugin identity and safe correlation ID.
- KIT-LOG-3. Status color/shape map is shared; text is at most 19 code points; system overlays preserve lower-priority state.
- KIT-LOG-4. Native done errors preserve Catch behavior. `errorOutput` is last output, requires output count, sanitizes error fields, preserves previous error, and does not also trigger Catch.
- KIT-LOG-5. Status updates coalesce with trailing update at 250 ms default; timers unref and clear on close.
- KIT-LIFE-1. One LIFO close stack shares 10-second node deadline across cleanup; failed/skipped steps call force once and do not block older cleanup.
- KIT-LIFE-2. Close sets closing, aborts node signal, stops dispatch, and drains/cancels queued work.
- KIT-LIFE-3. `onStart` is registered once before input and runs after synchronous registration; attempt carries number/signal/close stack. Failed cleanup has a 5-second budget before retry; unsafe cleanup stops retry.
- KIT-LIFE-4. Redeploy during startup prevents readiness/stack transfer and cleans current attempt; late resource registration has explicit force/cleanup handling.
- KIT-LIFE-5. Plugin context has no shutdown stack or `flows:stopped` stop semantics. [review]
- KIT-LIFE-6. Failed attempt resources must be closed or forced before retry; unknown cleanup stops startup.
- KIT-LIFE-7. Successful startup does not restart automatically on driver outage; palettes handle reconnect and operations.

## 8. Redis and metrics

- KIT-RDS-1. Redis subpath receives the ioredis constructor from the palette and returns lazy `{ client, connect, close, force }` handles.
- KIT-RDS-2. Redis mode, topology, credentials, TLS, and timeout inputs are explicitly validated.
- KIT-RDS-3. Shared/blocking/subscriber roles have explicit safe queue, replay, timeout, and autopipeline settings.
- KIT-RDS-4. Cluster rejects nonzero DB and validates TLS against advertised hostnames.
- KIT-RDS-5. Connection name is diagnostic only and is restored on reconnect.
- KIT-RDS-6. Connection errors use deduplicated safe logging and explicit error classification.
- KIT-RDS-7. Scripts use defineCommand and never overwrite client methods.
- KIT-RDS-8. Hash tags reject ambiguous brace input; key schema remains palette-owned.
- KIT-RDS-9. Kit does not claim exactly-once or replay unknown destructive commands. Integration requires standalone, 3+ master cluster, replicas for failover, TLS hostname fixtures and fault-injection proxy.
- KIT-MET-1. Metrics source is rk-owned and refcounted with node-owned acquire/release.
- KIT-MET-2. Version 1 accepts Prometheus text 0.0.4 and rejects OpenMetrics.
- KIT-MET-3. Sources use sourceId and versioned `redkern:metrics:*` events with safe rediscovery.
- KIT-MET-4. Kit does not depend on prom-client or aggregate scrapes; receiver owns duplicate metric checks. [review]

## 9. Node-RED creation rules

- KIT-NR-2 through KIT-NR-5 apply to palette repositories. The kit ships no node types or editor resources; kit releases record these requirements as not applicable only when `check:pack` confirms that boundary and the palette checklist remains required for each consuming palette.

- KIT-NR-1. The real-runtime fixture calls `RED.nodes.createNode` before bind and verifies input/send/done behavior. Palette node names match across runtime/editor/help/template as checked by the palette checklist. [CI]
- KIT-NR-2. Palette node input/output counts, editor outputs, wires and error-output placement remain consistent. [palette]
- KIT-NR-3. Palette config nodes use `category: 'config'`, no flow ports, documented config references, missing-reference handling, and shared resource ownership. [palette]
- KIT-NR-4. Palette editor JS is strict-mode IIFE; credentials are not copied into flow properties; runtime validation remains authoritative. [palette]
- KIT-NR-5. Palette help describes inputs, each output, payload types, message changes, queue/order/error semantics, and credential prerequisites. [palette]
- KIT-NR-6. The kit package rejects Node-RED palette metadata/keyword and excludes editor resources; palette package metadata is checked by the palette checklist. [CI]
- KIT-NR-7. Integration uses the real Node-RED runtime/test-helper for node construction, input/send/message semantics, and runtime credentials; kit unit tests exercise public settings/admin APIs. Palette repositories test editor, deploy, and config-node workflows through the palette checklist. [CI]

## 10. Release, evidence and stages

Node.js minimum is 22. Node-RED support target is `>=4.1.0 <6.0.0`, published only for combinations actually tested and consistent with engine requirements. Kit has zero runtime dependencies and 100% executable line/branch coverage. TypeScript is pinned exactly; declarations are generated and committed from JS/JSDoc. Package files use strict whitelist/exports, changelog, public scoped access, exact repository metadata and provenance policy.

`docs/verification.json` maps each requirement to a stage and actual test/CI/lint/review evidence. Test evidence must correspond to assertions; skipped/todo/failing tests do not pass. Future-stage items remain explicitly deferred until RC; stable has no deferred requirements.

Stages: `alpha.1` init/bind/plugin, naming, config, secrets, resilience, async, logging, lifecycle, Node-RED conventions and standard; `alpha.2` auth/HTTP/metrics; `beta.1` Redis; `rc.1` API freeze and full matrix; `1.0.0` kit publishes before first stable palette. A release gate blocks on unavailable runtime/tooling evidence rather than claiming it passed.

## 11. Current stage evidence

The complete target remains larger than this implementation. See [verification.json](verification.json) for implemented, deferred, and failing evidence; this document is not a claim that alpha.1 acceptance is already complete.