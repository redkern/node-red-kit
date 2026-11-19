'use strict';

// Scenario tests for the 1.1.0 specification-compliance fixes. Each title carries the
// requirement ID whose substance it verifies.

const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const os = require('node:os');
const { EventEmitter } = require('node:events');
const kit = require('../..');
const { createSecretStore } = require('../../lib/secrets');
const { createLifecycle } = require('../../lib/lifecycle');
const { createStatus } = require('../../lib/logging');
const { createInternalServer } = require('../../lib/internal-server');
const { names } = require('../../lib/naming');
const { createRedisClient } = require('../../redis');

const TOKEN = '0123456789abcdefghijklmnopqrstuv';
const tick = () => new Promise((resolve) => setImmediate(resolve));
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function mockRED(settings = {}) {
  const logs = [];
  return {
    logs,
    value: {
      settings,
      events: new EventEmitter(),
      log: Object.fromEntries(['error', 'warn', 'info', 'debug'].map((level) => [level, (message) => logs.push([level, message])]))
    }
  };
}

function mockNode(id) {
  const node = new EventEmitter();
  node.id = id;
  node.type = 'redkern-redis-test';
  node.credentials = {};
  node.statuses = [];
  node.status = (value) => node.statuses.push(value);
  node.logs = [];
  for (const level of ['error', 'warn', 'log', 'debug']) node[level] = (message) => node.logs.push([level, message]);
  return node;
}

function input(node, msg, send = () => {}) {
  return new Promise((resolve) => node.emit('input', msg, send, resolve));
}

function close(node) {
  return new Promise((resolve) => node.emit('close', false, resolve));
}

function lastStatus(node) {
  return node.statuses.at(-1);
}

async function freePort() {
  const probe = net.createServer();
  await new Promise((resolve, reject) => probe.listen(0, '127.0.0.1', (error) => error ? reject(error) : resolve()));
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

test('KIT-SEC-6 redaction snapshot keeps masking a secret whose owner closed during the operation', () => {
  const store = createSecretStore();
  const release = store.acquire('owner-secret-1');
  const snapshot = store.snapshot();
  release();
  store.acquire('registered-later');
  assert.equal(store.redactText('owner-secret-1'), 'owner-secret-1');
  assert.equal(snapshot.redactText('owner-secret-1 registered-later'), '[REDACTED] [REDACTED]');
  assert.equal(snapshot.redactValue(new Error('failed owner-secret-1')).message, 'failed [REDACTED]');
  assert.equal(snapshot.released, false);
  snapshot.release();
  assert.equal(snapshot.released, true);
  assert.equal(snapshot.redactText('owner-secret-1'), 'owner-secret-1');
});

test('KIT-SEC-6 input error after the config node released its password does not reveal it', async () => {
  const rk = kit.init(mockRED().value, { domain: 'redis' });
  const config = rk.bind(mockNode('config'));
  const releasePassword = config.secret('S3cretPass!');
  const consumerNode = mockNode('consumer');
  const consumer = rk.bind(consumerNode);
  consumer.onInput(async () => {
    await wait(20);
    throw new Error('auth failed for S3cretPass!');
  }, { concurrency: 1 });
  const pending = input(consumerNode, {});
  await tick();
  releasePassword();
  const error = await pending;
  assert.equal(error.message, 'auth failed for [REDACTED]');
});

test('KIT-SEC-6 late input settlement after close logs only a fixed code and operation ID', async () => {
  const rk = kit.init(mockRED().value, { domain: 'redis', closeTimeoutMs: 20 });
  const node = mockNode('late-input');
  const k = rk.bind(node);
  k.secret('late-secret-value');
  let finish;
  k.onInput(() => new Promise((_, reject) => { finish = reject; }), { concurrency: 1 });
  const pending = input(node, {});
  await tick();
  await close(node);
  assert.equal((await pending).code, 'NODE_CLOSING');
  finish(new Error('late failure late-secret-value'));
  await tick();
  const late = node.logs.filter(([, message]) => /Late operation/.test(message));
  assert.equal(late.length, 1);
  assert.match(late[0][1], /Late operation [0-9a-f-]{36} failed$/);
  assert.equal(node.logs.some(([, message]) => message.includes('late-secret-value')), false);
});

test('KIT-SEC-6 late successful input after close is reported as completed', async () => {
  const rk = kit.init(mockRED().value, { domain: 'redis', closeTimeoutMs: 20 });
  const node = mockNode('late-success');
  const k = rk.bind(node);
  let finish;
  k.onInput(() => new Promise((resolve) => { finish = resolve; }), { concurrency: 1 });
  const pending = input(node, {});
  await tick();
  await close(node);
  await pending;
  finish();
  await tick();
  assert.equal(node.logs.some(([, message]) => /Late operation [0-9a-f-]{36} completed$/.test(message)), true);
});

test('KIT-ASYNC-1 track logs non-Error rejections without serializing them', async () => {
  const rk = kit.init(mockRED().value, { domain: 'redis' });
  const node = mockNode('track-primitive');
  const k = rk.bind(node);
  k.secret('primitive-secret');
  assert.equal(await k.track(Promise.reject('primitive-secret leaked')), false);
  assert.equal(node.logs.some(([, message]) => message.includes('primitive-secret')), false);
  assert.equal(node.logs.some(([, message]) => message.includes('Tracked operation failed')), true);
});

test('KIT-ARCH-9 plugin track tolerates empty rejections and masks snapshot secrets', async () => {
  const mock = mockRED();
  const rk = kit.init(mock.value, { domain: 'splitter' });
  const plugin = rk.plugin({ id: 'splitter-runtime' });
  assert.equal(await plugin.track(Promise.reject()), false);
  assert.equal(await plugin.track(Promise.reject(null), { label: 'sync' }), false);
  assert.equal(await plugin.track(Promise.reject(Object.assign(new Error('write failed'), { code: 'EIO' }))), false);
  assert.equal(await plugin.track(Promise.resolve()), true);
  assert.equal(mock.logs.filter(([level]) => level === 'error').length, 3);
});

test('KIT-LOG-5 invalid configuration stays visible over a requested status', async () => {
  const rk = kit.init(mockRED().value, { domain: 'redis', statusOptions: { minIntervalMs: 0 } });
  const node = mockNode('config-priority');
  const k = rk.bind(node);
  k.configure({ count: 'abc' }, { count: { type: 'int' } });
  k.status('ok', 'connected');
  assert.deepEqual(lastStatus(node), { fill: 'red', shape: 'ring', text: 'CONFIG_INVALID' });
  assert.equal(k.requireSecret('', 'password'), false);
  assert.equal(k.requireSecret('', 'password'), false);
  assert.deepEqual(lastStatus(node), { fill: 'red', shape: 'ring', text: 'SECRET_REQUIRED' });
  await close(node);
});

test('KIT-LOG-5 startup states outrank requested status and ready restores base ok', async () => {
  const rk = kit.init(mockRED().value, { domain: 'redis', statusOptions: { minIntervalMs: 0 } });
  const node = mockNode('start-priority');
  const k = rk.bind(node);
  let connect;
  k.onStart(() => new Promise((resolve) => { connect = resolve; }));
  k.status('ok', 'premature');
  assert.equal(lastStatus(node).text, 'starting');
  await tick();
  connect();
  await tick();
  await tick();
  assert.deepEqual(lastStatus(node), { fill: 'green', shape: 'dot', text: 'ready' });
  await close(node);
});

test('KIT-LOG-5 permanent startup failure outranks requested and error-counter status', async () => {
  const rk = kit.init(mockRED().value, { domain: 'redis', statusOptions: { minIntervalMs: 0 } });
  const node = mockNode('failed-priority');
  const k = rk.bind(node);
  k.onStart(async () => { throw new kit.ConfigError([{ field: 'host', code: 'INVALID', message: 'bad host' }]); });
  k.onInput(async () => {}, { concurrency: 1, startQueueTimeoutMs: 100, errorOutput: true, outputCount: 1 });
  await tick();
  await tick();
  k.status('ok', 'requested');
  assert.deepEqual(lastStatus(node), { fill: 'red', shape: 'ring', text: 'CONFIG_INVALID' });
  await close(node);
});

test('KIT-LOG-5 error counter does not hide startup and closing overlays hide everything', async () => {
  const rk = kit.init(mockRED().value, { domain: 'redis', statusOptions: { minIntervalMs: 0 } });
  const node = mockNode('counter-priority');
  const k = rk.bind(node);
  k.onInput(async () => { throw new Error('boom'); }, { concurrency: 1, errorOutput: true, outputCount: 1 });
  await input(node, {});
  assert.equal(lastStatus(node).text, 'errors 1');
  k.status('ok', 'requested');
  assert.equal(lastStatus(node).text, 'errors 1');
  const closing = close(node);
  assert.deepEqual(lastStatus(node), { fill: 'grey', shape: 'ring', text: 'closing' });
  await closing;
});

test('KIT-LOG-5 overlay priority must be finite', () => {
  const node = mockNode('overlay');
  const status = createStatus(node, { minIntervalMs: 0 });
  assert.throws(() => status.setOverlay('bad', 'error', 'text', Number.NaN), /finite/);
  status.setOverlay('low', 'error', 'low', 1);
  status.setOverlay('high', 'ok', 'high', 2);
  assert.equal(lastStatus(node).text, 'high');
  status.dispose();
});

test('KIT-MET-1 a node can release and reacquire its metrics lease', () => {
  const RED = mockRED().value;
  const events = [];
  RED.events.on('redkern:metrics:register', () => events.push('register'));
  RED.events.on('redkern:metrics:unregister', () => events.push('unregister'));
  const rk = kit.init(RED, { domain: 'redis', metrics: { contentType: 'text/plain; version=0.0.4', metrics: async () => '' } });
  const k = rk.bind(mockNode('metrics-owner'));
  const first = k.metrics.acquire();
  assert.throws(() => k.metrics.acquire(), /already acquired/);
  first();
  first();
  const second = k.metrics.acquire();
  second();
  assert.deepEqual(events, ['register', 'unregister', 'register', 'unregister']);

  assert.equal(RED.events.listenerCount('redkern:metrics:discover'), 0);
});

test('KIT-MET-1 a closing node cannot acquire a lease that would outlive it', async () => {
  const rk = kit.init(mockRED().value, { domain: 'redis', metrics: { contentType: 'text/plain; version=0.0.4', metrics: async () => '' } });
  const node = mockNode('closing-lease');
  const k = rk.bind(node);
  const closing = close(node);
  assert.throws(() => k.metrics.acquire(), /while the node is closing/);
  await closing;
});

test('KIT-HTTP-7 nodes with invalid configuration cannot acquire service leases', () => {
  const rk = kit.init(mockRED().value, { domain: 'redis', metrics: { contentType: 'text/plain; version=0.0.4', metrics: async () => '' } });
  const k = rk.bind(mockNode('invalid-lease'));
  k.configure({}, { host: { type: 'str', required: true } });
  assert.throws(() => k.metrics.acquire(), /configuration is invalid/);
});

test('KIT-CFG-8 palette parameters cannot redeclare automatic token parameters', () => {
  const RED = mockRED().value;
  assert.throws(() => kit.init(RED, { domain: 'prom', secrets: { metrics: { required: false } }, params: { metricsToken: { type: 'str' } } }), /reserved metrics token/);
  assert.throws(() => kit.init(RED, { domain: 'prom', secrets: { APIKey: { required: false } } }), /Invalid secret schema/);
  assert.throws(() => kit.init(RED, { domain: 'prom', routes: [] }), /Unsupported init option: routes/);
});

test('KIT-CFG-7 invalid enabled exposes a safe disabledReason with issues', () => {
  process.env.REDKERN_PROM_ENABLED = 'off';
  try {
    const rk = kit.init(mockRED().value, { domain: 'prom' });
    assert.deepEqual(rk.disabledReason, {
      code: 'PALETTE_DISABLED_INVALID',
      message: 'Palette enabled setting is invalid',
      issues: [{ field: 'enabled', code: 'PALETTE_DISABLED_INVALID', message: 'enabled must be true, false, 1, or 0' }]
    });
  } finally {
    delete process.env.REDKERN_PROM_ENABLED;
  }
});

test('KIT-SEC-5 standard list masks header and suffix-named credential fields', () => {
  const store = createSecretStore();
  const masked = store.redactValue({
    headers: { 'x-api-key': 'k', 'proxy-authorization': 'p', cookie: 'c' },
    accessToken: 'a',
    refresh_token: 'r',
    dbPassword: 'd',
    privateKey: 'pk',
    credentials: { user: 'u' },
    tokenCount: 3,
    secretName: 'visible'
  });
  assert.deepEqual(masked, {
    headers: { 'x-api-key': '[REDACTED]', 'proxy-authorization': '[REDACTED]', cookie: '[REDACTED]' },
    accessToken: '[REDACTED]',
    refresh_token: '[REDACTED]',
    dbPassword: '[REDACTED]',
    privateKey: '[REDACTED]',
    credentials: '[REDACTED]',
    tokenCount: 3,
    secretName: 'visible'
  });
});

test('KIT-RES-1 backoff never returns NaN and stays capped after overflow', () => {
  const zero = kit.backoff({ initial: 0, max: 10 });
  for (let index = 0; index < 1200; index += 1) assert.equal(zero.next(), 0);
  const steep = kit.backoff({ initial: 1, max: 1000, multiplier: 1e300, jitter: 0 });
  assert.equal(steep.next(), 1);
  assert.equal(steep.next(), 1000);
  assert.equal(steep.next(), 1000);
  steep.reset();
  assert.equal(steep.next(), 1);
  const overflow = kit.backoff({ initial: 1e-300, max: 2147483647, multiplier: 1e300, jitter: 0 });
  assert.equal(overflow.next(), 0);
  assert.equal(overflow.next(), 1);
  assert.equal(overflow.next(), 2147483647);
  assert.equal(overflow.next(), 2147483647);
});

test('KIT-RES-3 retry propagates retryOn failures with the original cause and tolerates null rejections', async () => {
  const original = new Error('first');
  const classifierError = new Error('classifier failed');
  await assert.rejects(kit.retry(() => { throw original; }, {
    attempts: 3,
    backoff: kit.backoff({ initial: 0, max: 0 }),
    retryOn: () => { throw classifierError; }
  }), (error) => error === classifierError && error.cause === original);
  const withCause = Object.assign(new Error('has cause'), { cause: 'kept' });
  await assert.rejects(kit.retry(() => { throw original; }, {
    attempts: 2,
    backoff: kit.backoff({ initial: 0, max: 0 }),
    retryOn: () => { throw withCause; }
  }), (error) => error.cause === 'kept');
  await assert.rejects(kit.retry(() => { throw 'primitive'; }, {
    attempts: 2,
    backoff: kit.backoff({ initial: 0, max: 0 }),
    retryOn: () => { throw 'string failure'; }
  }), (error) => error === 'string failure');
  let calls = 0;
  await assert.rejects(kit.retry(() => { calls += 1; return Promise.reject(null); }, {
    attempts: 2,
    backoff: kit.backoff({ initial: 0, max: 0 }),
    retryOn: () => true
  }), (error) => error === null);
  assert.equal(calls, 2);
});

test('KIT-LIFE-3 AbortError classifies as stop and code-less startup failures retry', async () => {
  assert.equal(kit.classifyError(Object.assign(new Error('aborted'), { name: 'AbortError' })), 'stop');
  assert.equal(kit.classifyError({ code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' }), 'auth');
  const controller = new AbortController();
  const statuses = [];
  const lifecycle = createLifecycle({
    signal: controller.signal,
    abort: () => controller.abort(),
    log: { error() {}, warn() {} },
    status: (...args) => statuses.push(args)
  });
  let attempts = 0;
  const started = lifecycle.onStart(async () => {
    attempts += 1;
    if (attempts === 1) throw undefined;
  });
  await wait(1100);
  await started;
  assert.equal(attempts, 2);
  assert.deepEqual(statuses[1], ['starting', 'try 1 error', { phase: 'starting' }]);
  assert.equal(lifecycle.startState, 'ready');
  await lifecycle.close();
});

test('KIT-LIFE-1 a close step that settles after the deadline is reported as a late operation', async () => {
  const controller = new AbortController();
  const logs = [];
  const lifecycle = createLifecycle({
    signal: controller.signal,
    abort: () => controller.abort(),
    log: { error: (...args) => logs.push(['error', ...args]), warn: (...args) => logs.push(['warn', ...args]) },
    status() {},
    timeoutMs: 20
  });
  let finish;
  let forced = 0;
  lifecycle.onClose(() => new Promise((resolve) => { finish = resolve; }), { force: () => { forced += 1; } });
  await lifecycle.close();
  assert.equal(forced, 1);
  finish();
  await tick();
  assert.equal(logs.some(([level, message, options]) => level === 'warn' && options.key === 'LATE_OPERATION_COMPLETED' && /Late close operation [0-9a-f-]{36} completed/.test(message)), true);
});

test('KIT-HTTP-7 acquire during the last release is serialized and does not hang the release', async () => {
  const port = await freePort();
  const server = createInternalServer({
    domainNames: names('redis'),
    port,
    routes: [{ method: 'GET', path: '/health', auth: 'local', handler: async (_req, res) => res.json({ ok: true }) }],
    log: { error() {}, warn() {} }
  });
  const first = server.acquire('first', {});
  await first.ready;
  const started = Date.now();
  const releasing = first.release();
  const second = server.acquire('second', {});
  await second.ready;
  await releasing;
  assert.ok(Date.now() - started < 900, 'new listener must open without a bind-conflict retry');
  const response = await fetch(`http://127.0.0.1:${port}/redkern/redis/health`);
  assert.deepEqual(await response.json(), { ok: true });
  await second.release();
});

test('KIT-HTTP-12 internal routes support their own handler timeout and ignore late writes', async () => {
  const port = await freePort();
  const records = [];
  let lateWrite;
  const server = createInternalServer({
    domainNames: names('redis'),
    port,
    routes: [
      {
        method: 'GET',
        path: '/slow',
        auth: 'local',
        handlerTimeoutMs: 20,
        handler: (_req, res) => new Promise((resolve) => {
          lateWrite = () => {
            res.setHeader('x-late', '1');
            res.json({ late: true });
            res.text('late');
            resolve();
          };
        })
      },
      { method: 'GET', path: '/primitive', auth: 'local', handler: async () => { throw 'primitive failure'; } }
    ],
    log: { error: (...args) => records.push(['error', ...args]), warn: (...args) => records.push(['warn', ...args]) },
    handlerTimeoutMs: 10000
  });
  const lease = server.acquire('owner', {});
  await lease.ready;
  const slow = await fetch(`http://127.0.0.1:${port}/redkern/redis/slow`);
  assert.equal(slow.status, 504);
  assert.equal(slow.headers.get('x-late'), null);
  lateWrite();
  await tick();
  assert.equal(records.some(([level, , options]) => level === 'warn' && options.key === 'LATE_OPERATION_COMPLETED'), true);
  const primitive = await fetch(`http://127.0.0.1:${port}/redkern/redis/primitive`);
  assert.equal(primitive.status, 500);
  assert.equal(records.some(([level, message]) => level === 'error' && /failed: primitive failure/.test(message)), true);
  await lease.release();
});

function adminRED() {
  const routes = [];
  const logs = [];
  const app = {};
  for (const method of ['get', 'post', 'put', 'patch', 'delete']) {
    app[method] = (path, permission, handler) => routes.push({ path, handler });
  }
  return {
    routes,
    logs,
    value: {
      settings: { adminAuth: { type: 'credentials' } },
      httpAdmin: app,
      auth: { needsPermission: () => (req, res, next) => next() },
      log: Object.fromEntries(['error', 'warn', 'info', 'debug'].map((level) => [level, (message) => logs.push([level, message])]))
    }
  };
}

function adminResponse() {
  const response = new EventEmitter();
  response.statusCode = 200;
  response.headersSent = false;
  response.writableEnded = false;
  response.headers = {};
  response.status = (code) => { response.statusCode = code; return response; };
  response.setHeader = (name, value) => { response.headers[name] = value; };
  response.json = (body) => { response.body = body; response.headersSent = true; response.writableEnded = true; };
  response.type = () => response;
  response.send = (body) => { response.body = body; response.headersSent = true; response.writableEnded = true; };
  response.destroy = () => { response.destroyed = true; };
  return response;
}

test('KIT-HTTP-4 admin handler AbortError without client disconnect gets a controlled 500', async () => {
  const mock = adminRED();
  const rk = kit.init(mock.value, { domain: 'redis' });
  const registry = rk.createRouteRegistry({
    method: 'GET',
    path: '/abort',
    permission: 'redkern.redis.read',
    handler: async () => { throw Object.assign(new Error('driver aborted'), { name: 'AbortError' }); }
  });
  registry.add('owner', {});
  const response = adminResponse();
  mock.routes[0].handler({ method: 'GET', headers: {} }, response);
  await wait(5);
  assert.equal(response.statusCode, 500);
  assert.equal(response.body.error, 'Internal error');
});

test('KIT-HTTP-11 admin client disconnect aborts silently and late facade writes are ignored', async () => {
  const mock = adminRED();
  const rk = kit.init(mock.value, { domain: 'redis' });
  let facade;
  let signal;
  const registry = rk.createRouteRegistry({
    method: 'GET',
    path: '/disconnect',
    permission: 'redkern.redis.read',
    handler: async (req, res) => {
      facade = res;
      signal = req.signal;
      await new Promise((resolve) => req.signal.addEventListener('abort', resolve));
    }
  });
  registry.add('owner', {});
  const response = adminResponse();
  mock.routes[0].handler({ method: 'GET', headers: {} }, response);
  await tick();
  response.emit('close');
  await tick();
  assert.equal(signal.aborted, true);
  assert.equal(response.body, undefined);
  facade.json({ late: true });
  facade.setHeader('x-late', '1');
  assert.equal(response.headers['x-late'], undefined);
});

test('KIT-HTTP-12 admin routes support per-route timeout, primitive errors, and reject unknown options', async () => {
  const mock = adminRED();
  const rk = kit.init(mock.value, { domain: 'redis', handlerTimeoutMs: 10000 });
  assert.throws(() => rk.createRouteRegistry({ method: 'GET', path: '/x', permission: 'redkern.redis.read', handler() {}, auth: 'local' }), /Unsupported route option/);
  let finish;
  const slow = rk.createRouteRegistry({
    method: 'GET',
    path: '/slow',
    permission: 'redkern.redis.read',
    handlerTimeoutMs: 10,
    handler: () => new Promise((resolve) => { finish = resolve; })
  });
  slow.add('owner', {});
  const slowResponse = adminResponse();
  mock.routes.at(-1).handler({ method: 'GET', headers: {} }, slowResponse);
  await wait(30);
  assert.equal(slowResponse.statusCode, 504);
  finish();
  await tick();
  assert.equal(mock.logs.some(([level, message]) => level === 'warn' && /Late HTTP operation [0-9a-f-]{36} completed/.test(message)), true);

  const primitive = rk.createRouteRegistry({ method: 'GET', path: '/primitive', permission: 'redkern.redis.read', handler: async () => { throw null; } });
  primitive.add('owner', {});
  const primitiveResponse = adminResponse();
  mock.routes.at(-1).handler({ method: 'GET', headers: {} }, primitiveResponse);
  await wait(5);
  assert.equal(primitiveResponse.statusCode, 500);

  const rejecting = rk.createRouteRegistry({ method: 'GET', path: '/late-fail', permission: 'redkern.redis.read', handlerTimeoutMs: 10, handler: () => new Promise((_, reject) => { finish = reject; }) });
  rejecting.add('owner', {});
  mock.routes.at(-1).handler({ method: 'GET', headers: {} }, adminResponse());
  await wait(30);
  finish(new Error('late'));
  await tick();
  assert.equal(mock.logs.some(([level, message]) => level === 'warn' && /Late HTTP operation [0-9a-f-]{36} failed/.test(message)), true);

  const text = rk.createRouteRegistry({
    method: 'GET',
    path: '/text',
    permission: 'redkern.redis.read',
    handler: async (_req, res) => res.text('# metrics', 'application/openmetrics-text; version=1.0.0')
  });
  text.add('owner', {});
  const textResponse = adminResponse();
  mock.routes.at(-1).handler({ method: 'GET', headers: {} }, textResponse);
  await wait(5);
  assert.equal(textResponse.statusCode, 500);
});

test('KIT-RDS-5 connection name rejects whitespace or control characters from the host name', () => {
  const original = os.hostname;
  os.hostname = () => 'bad host';
  try {
    class Fake extends EventEmitter {}
    Fake.Cluster = class extends EventEmitter {};
    assert.throws(() => createRedisClient({
      ioredis: Fake,
      domain: 'redis',
      configId: '12345678',
      role: 'shared',
      mode: 'standalone',
      host: 'redis',
      port: 6379,
      logger: { error() {} }
    }), /connection name/);
  } finally {
    os.hostname = original;
  }
});

test('KIT-HTTP-6 init rejects a listener that mixes local and token routes', () => {
  process.env.REDKERN_GATEWAY_DRAIN_TOKEN = TOKEN;
  try {
    assert.throws(() => kit.init(mockRED().value, {
      domain: 'gateway',
      secrets: { drain: { required: true } },
      internalServer: {
        port: 9552,
        routes: [
          { method: 'POST', path: '/drain', auth: { token: 'drain' }, handler() {} },
          { method: 'GET', path: '/health', auth: 'local', handler() {} }
        ]
      }
    }), /cannot mix local and token routes/);
  } finally {
    delete process.env.REDKERN_GATEWAY_DRAIN_TOKEN;
  }
});
