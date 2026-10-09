# @redkern/node-red-kit

Shared runtime library for redkern Node-RED palettes. It registers no node types, editor resources, or runtime plugins by itself and has no runtime dependencies.

> **Status:** Stable release, version `1.0.1`. Implemented: init/bind/plugin, naming, config, secrets, auth, admin/internal HTTP, metrics source lifecycle, Redis client factory, resilience, async, logging, and lifecycle.

## Requirements

- Node.js 22 or newer
- Node-RED runtime APIs are used through the `RED` object supplied to the palette

## Initialize a palette

Call `init` once in the palette module closure. Every node constructor must call `RED.nodes.createNode` before `bind`:

```js
const kit = require('@redkern/node-red-kit');

module.exports = function (RED) {
  const rk = kit.init(RED, {
    domain: 'gateway',
    settingsType: 'redkern-gateway-config'
  });

  function PrefixNode(config) {
    RED.nodes.createNode(this, config);
    const k = rk.bind(this);
    const parsed = k.configure(config, {
      prefix: { type: 'str', default: '' }
    });

    k.onInput(async (msg, send) => {
      if (!parsed.ok) throw new kit.ConfigError(parsed.errors);
      if (typeof msg.payload !== 'string') {
        throw new kit.ConfigError([
          { field: 'payload', code: 'INVALID_TYPE', message: 'Expected string' }
        ]);
      }
      msg.payload = parsed.value.prefix + msg.payload;
      send(msg);
    }, { concurrency: 8, maxQueue: 800 });
  }

  RED.nodes.registerType('redkern-gateway-prefix', PrefixNode);
};
```

The input handler receives `(msg, send)` only. Kit owns Node-RED's native `done` callback, calls it once after success, and calls `done(error)` after a rejected handler. It forwards the provided `send` callback and does not JSON-clone messages. Async startup must be registered before `onInput`; when `onStart` exists, `startQueueTimeoutMs` is required.

## Configuration

`init(RED, options)` returns `{ names, config, enabled, disabledReason, bind(node), plugin({ id }), createRouteRegistry(route) }`. Palette parameters resolve from non-empty `REDKERN_<DOMAIN>_<NAME>`, then the Node-RED custom setting derived from `settingsType`, then the schema default. Empty environment/settings values fall through. Invalid selected values do not fall through and disable the palette before I/O.

`parseConfig(config, schema)` returns `{ ok: true, value }` or `{ ok: false, errors }`; there is no partial value on failure. Supported schema types are `int`, `float`, `bool`, `str`, `list`, and `enum`. `readEnv(name)` accepts only a complete `REDKERN_*` variable name. `readSettings(RED, settingsType, schema)` reads only schema-allowlisted fields using Node-RED's type-prefixed camelCase setting names.

Node fields are read only from the flow config. Kit does not re-expand values from `process.env`. Node-RED whole-property `${NAME}` placeholders that remain unresolved become safe config errors.

## Secrets

Declare credentials in the palette's editor definition, then read them with `k.readSecret(field, { legacyConfig })`. An explicitly present empty credential means cleared and does not revive a legacy value. Legacy fallback is opt-in and emits a one-time warning. Use `k.requireSecret(value, label)` before `onStart` when a value is mandatory. `k.secret(value)` returns an idempotent release function and also releases automatically when the node closes.

Secrets declared in `init({ secrets })` are read from `REDKERN_<DOMAIN>_<NAME>_TOKEN` or the corresponding private `settingsType` setting. Required values must be 32-4096 printable ASCII characters without whitespace. Values are never included in `rk.config`; active values and sensitive fields are redacted from kit logs and error-output messages.

## Async and lifecycle

`k.onStart(async (attempt) => {}, { classify, startAlertMs })` retries transient failures with capped full-jitter backoff. `attempt` provides its number, signal, and `onClose(fn, { force })`. Each failed attempt is cleaned before retry.

`k.onInput(handler, { concurrency, maxQueue, startQueueTimeoutMs, errorOutput, outputCount })` uses a bounded FIFO limiter. Startup deadlines begin when a message arrives. `errorOutput` requires an `outputCount`; failures go to the last output and native `done()` is called without an error. `k.onClose(fn, { force })` adds a LIFO cleanup step under the shared close budget. Active input work drains before resource cleanup under that same deadline.

`k.track(promise, { label, key })` consumes rejection and resolves to a boolean. `backoff(options)` returns `next()`/`reset()`. `sleep(ms, signal)` is abortable. `retry(fn, options)` invokes `fn({ attempt, signal })` and retries only when its explicit `retryOn(error)` predicate allows it. `withTimeout(promise, ms, options)` stops waiting but does not cancel the underlying operation. `createLimiter({ concurrency, maxQueue })` returns `run`, `close`, and `stats`.

## Authentication and admin routes

`secureCompare(expected, supplied)` uses fresh-key HMAC digests and `timingSafeEqual`. `extractToken(req)` accepts an unambiguous Bearer or `x-api-key` header; query tokens are rejected. `requireSecret(k, value, label)` validates a required node secret. `PublicError(status, message, { code })` represents a public 4xx response.

`rk.createRouteRegistry({ method, path, permission, handler })` registers on `RED.httpAdmin` through `RED.auth.needsPermission`. Routes fail closed when `adminAuth` is missing or the admin API is disabled. Paths are static suffixes under `rk.names.routeBase`; write methods require `application/json` with optional UTF-8 charset. The handler receives a normalized request, response facade, and active-entry snapshot. `init({ internalServer })` creates a lazy listener with exact local/token auth and per-node acquire/release leases. Cluster retry, mesh/preStop evidence, and fault-injection acceptance remain release work.

```js
module.exports = function (RED) {
  const rk = kit.init(RED, {
    domain: 'gateway',
    internalServer: {
      port: 9552,
      routes: [{
        method: 'GET',
        path: '/health',
        auth: 'local',
        handler: async (_req, res, activeEntries) => res.json({ owners: activeEntries.size })
      }]
    }
  });

  function HealthNode(config) {
    RED.nodes.createNode(this, config);
    const k = rk.bind(this);
    const lease = k.internalServer.acquire(this.id, { node: this });
    k.track(lease.ready, { label: 'health listener' });
  }

  RED.nodes.registerType('redkern-gateway-health', HealthNode);
};
```

## Metrics source

When `init` receives `metrics: { contentType, metrics }`, each node can call `k.metrics.acquire()` once and release automatically on close. The palette-level source registers on the first lease, unregisters on the last, and re-announces after `redkern:metrics:discover`. V1 accepts only Prometheus text 0.0.4. The metrics receiver/aggregator remains palette-owned rather than part of kit.

## Redis client factory

The `@redkern/node-red-kit/redis` subpath exports `createRedisClient`, `classifyRedisError`, `defineScripts`, and `hashTag`. The palette passes its ioredis constructor; the kit does not install or import ioredis. The factory returns a lazy handle with `client`, `connect()`, `close()`, and synchronous `force()`. Role options disable offline command buffering and hidden command replay. Standalone is integration-tested; cluster/TLS/fault-injection acceptance is still required before stable release.

## Node-RED conventions

Use the message's passed `send` callback and preserve unrelated message properties. Use `node.send` only for source-node events. Always catch asynchronous failures through the returned promise path; do not call `node.error` for the same failure already sent through native `done(error)`. Status colors/shapes follow Node-RED and status text stays below 20 characters.

See the [JavaScript node guide](https://nodered.org/docs/creating-nodes/node-js), [status guide](https://nodered.org/docs/creating-nodes/status), and [packaging guide](https://nodered.org/docs/creating-nodes/packaging). The kit remains a library: it deliberately has no `node-red` package metadata or `node-red` keyword.

## Security and support

Report vulnerabilities through GitHub Private Vulnerability Reporting or to security@redkern.com; do not open a public issue for an unpatched vulnerability. For general support, use GitHub issues or support@redkern.com. See [SECURITY.md](SECURITY.md).