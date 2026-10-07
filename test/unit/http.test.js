'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const kit = require('../..');

function makeRED({ adminAuth = true, httpAdminRoot = '/' } = {}) {
  const routes = [];
  const logs = [];
  const app = {};
  for (const method of ['get', 'post', 'put', 'patch', 'delete']) {
    app[method] = (path, permission, handler) => routes.push({ method, path, permission, handler });
  }
  const settings = { httpAdminRoot };
  if (adminAuth) settings.adminAuth = { type: 'credentials' };
  return {
    routes,
    logs,
    value: {
      settings,
      routes,
      httpAdmin: app,
      auth: { needsPermission: (permission) => (req, res, next) => { req.permission = permission; next(); } },
      log: Object.fromEntries(['error', 'warn', 'info', 'debug'].map((level) => [level, (message) => logs.push([level, message])]))
    }
  };
}

function makeResponse() {
  const response = new EventEmitter();
  response.statusCode = 200;
  response.headersSent = false;
  response.writableEnded = false;
  response.status = (code) => { response.statusCode = code; return response; };
  response.setHeader = (name, value) => { response.headers = { ...response.headers, [name]: value }; };
  response.json = (body) => { response.body = body; response.headersSent = true; response.writableEnded = true; };
  response.type = (contentType) => { response.contentType = contentType; return response; };
  response.send = (body) => { response.body = body; response.headersSent = true; response.writableEnded = true; };
  response.destroy = () => { response.destroyed = true; };
  return response;
}

function routeFor(RED, method, path, handler, permission = 'redkern.redis.read', handlerTimeoutMs) {
  const rk = kit.init(RED, { domain: 'redis', handlerTimeoutMs });
  const registry = rk.createRouteRegistry({ method, path, permission, handler });
  return { rk, registry, registered: RED.routes.at(-1) };
}

async function invoke(handler, request, response) {
  handler(request, response);
  await new Promise((resolve) => setImmediate(resolve));
}

test('admin route registration uses public permission API and active-entry snapshot', async () => {
  const mock = makeRED();
  let observedPermission;
  let observedSize;
  const { registry, registered } = routeFor(mock.value, 'GET', '/events', async (req, res, entries) => {
    observedSize = entries.size;
    assert.equal(entries.set, undefined);
    assert.equal(Object.isFrozen(entries), true);
    res.json({ count: entries.size });
  });
  assert.equal(registered.path, '/redkern/redis/events');
  assert.equal(registered.method, 'get');
  assert.equal(typeof registered.permission, 'function');
  registry.add('node-1', { id: 'node-1' });
  assert.throws(() => registry.add('node-1', {}), /already exists/);
  assert.throws(() => registry.add('', {}), /id is required/);
  const response = makeResponse();
  const request = { method: 'GET', path: '/redkern/redis/events', query: {}, headers: {} };
  registered.permission(request, response, () => registered.handler(request, response));
  observedPermission = request.permission;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(observedPermission, 'redkern.redis.read');
  assert.equal(observedSize, 1);
  assert.deepEqual(response.body, { count: 1 });
  assert.equal(registry.remove('node-1'), true);
  assert.equal(registry.remove('missing'), false);
});

test('admin route fails closed without adminAuth or when admin API is disabled', () => {
  const noAuth = makeRED({ adminAuth: false });
  const first = routeFor(noAuth.value, 'GET', '/status', () => {});
  assert.equal(first.registry.available, false);
  assert.equal(noAuth.routes.length, 0);
  assert.equal(noAuth.logs.some(([level]) => level === 'warn'), true);

  const disabled = makeRED({ httpAdminRoot: false });
  const second = routeFor(disabled.value, 'GET', '/status', () => {});
  assert.equal(second.registry.available, false);
  assert.equal(disabled.routes.length, 0);
});

test('route definition rejects invalid methods, paths, permissions, and handlers', () => {
  const mock = makeRED();
  const rk = kit.init(mock.value, { domain: 'redis' });
  for (const route of [
    null,
    { method: 1, path: '/events', permission: 'redkern.redis.read', handler() {} },
    { method: 'TRACE', path: '/events', permission: 'redkern.redis.read', handler() {} },
    { method: 'GET', path: 'events', permission: 'redkern.redis.read', handler() {} },
    { method: 'GET', path: '/../admin', permission: 'redkern.redis.read', handler() {} },
    { method: 'GET', path: '/:id', permission: 'redkern.redis.read', handler() {} },
    { method: 'GET', path: '/events/', permission: 'redkern.redis.read', handler() {} },
    { method: 'GET', path: '/events', permission: 'read', handler() {} },
    { method: 'GET', path: '/events', permission: 'redkern.redis.read' }
  ]) assert.throws(() => rk.createRouteRegistry(route), TypeError);
});

test('route registration validates admin middleware and handler timeout', () => {
  const route = { method: 'GET', path: '/health', permission: 'redkern.redis.read', handler() {} };
  const noAuth = makeRED();
  noAuth.value.auth = {};
  assert.throws(() => routeFor(noAuth.value, route.method, route.path, route.handler), /RED.auth.needsPermission/);

  const invalidMiddleware = makeRED();
  invalidMiddleware.value.auth.needsPermission = () => undefined;
  assert.throws(() => routeFor(invalidMiddleware.value, route.method, route.path, route.handler), /middleware/);

  const badTimeout = makeRED();
  const rk = kit.init(badTimeout.value, { domain: 'redis', handlerTimeoutMs: 0 });
  assert.throws(() => rk.createRouteRegistry(route), /handlerTimeoutMs/);
});

test('empty registry returns 503 and JSON writes reject invalid media types', async () => {
  const mock = makeRED();
  const { registered } = routeFor(mock.value, 'POST', '/write', async () => assert.fail('inactive handler must not run'));
  const inactive = makeResponse();
  await invoke(registered.handler, { method: 'POST', path: '/redkern/redis/write', query: {}, headers: { 'content-type': 'application/json' } }, inactive);
  assert.equal(inactive.statusCode, 503);

  const second = makeRED();
  const route = routeFor(second.value, 'POST', '/write', async () => assert.fail('form body must be rejected'));
  route.registry.add('active', {});
  const response = makeResponse();
  await invoke(route.registered.handler, {
    method: 'POST', path: '/redkern/redis/write', query: {},
    headers: { 'content-type': 'application/x-www-form-urlencoded' }
  }, response);
  assert.equal(response.statusCode, 415);
});

test('DELETE without a body needs no JSON header while DELETE with body does', async () => {
  const noBodyMock = makeRED();
  let handled = false;
  const noBody = routeFor(noBodyMock.value, 'DELETE', '/delete', async (_req, res) => { handled = true; res.json({ ok: true }); });
  noBody.registry.add('active', {});
  const allowed = makeResponse();
  await invoke(noBody.registered.handler, { method: 'DELETE', path: '/redkern/redis/delete', query: {}, headers: {} }, allowed);
  assert.equal(handled, true);
  assert.equal(allowed.statusCode, 200);

  const withBodyMock = makeRED();
  const withBody = routeFor(withBodyMock.value, 'DELETE', '/delete', async () => assert.fail('non-JSON DELETE body must be rejected'));
  withBody.registry.add('active', {});
  const rejected = makeResponse();
  await invoke(withBody.registered.handler, { method: 'DELETE', path: '/redkern/redis/delete', query: {}, headers: { 'content-length': '2', 'content-type': 'text/plain' }, body: '{}' }, rejected);
  assert.equal(rejected.statusCode, 415);
});

test('admin JSON media type accepts UTF-8 and rejects malformed charset parameters', async () => {
  const acceptedTypes = ['application/json', 'application/json; charset="UTF-8"'];
  for (const contentType of acceptedTypes) {
    const mock = makeRED();
    const route = routeFor(mock.value, 'POST', '/json', async (req, res) => res.json({ value: req.body.value }));
    route.registry.add('active', {});
    const response = makeResponse();
    await invoke(route.registered.handler, {
      method: 'POST', path: '/redkern/redis/json', query: {},
      headers: { 'content-type': contentType }, body: { value: 'ok' }
    }, response);
    assert.deepEqual(response.body, { value: 'ok' });
  }

  for (const contentType of [undefined, 'text/plain', 'application/json; charset=utf-8; charset=utf-8', 'application/json; charset=latin1', 'application/json; broken']) {
    const mock = makeRED();
    const route = routeFor(mock.value, 'POST', '/json', async () => assert.fail('invalid media type handler must not run'));
    route.registry.add('active', {});
    const response = makeResponse();
    await invoke(route.registered.handler, {
      method: 'POST', path: '/redkern/redis/json', query: {},
      headers: contentType === undefined ? {} : { 'content-type': contentType }, body: {}
    }, response);
    assert.equal(response.statusCode, 415);
  }
});

test('admin handlers without a response fail closed with a request ID', async () => {
  const mock = makeRED();
  const route = routeFor(mock.value, 'GET', '/empty-response', async () => {});
  route.registry.add('active', {});
  const response = makeResponse();
  await invoke(route.registered.handler, {
    method: 'GET', path: '/redkern/redis/empty-response', query: {}, headers: {}
  }, response);
  assert.equal(response.statusCode, 500);
  assert.equal(typeof response.body.id, 'string');
});

test('response facade respects pre-sent headers and reserves Prometheus content type', async () => {
  const mock = makeRED();
  const route = routeFor(mock.value, 'GET', '/headers-sent', async (_req, res) => {
    res.text('ignored');
  });
  route.registry.add('active', {});
  const response = makeResponse();
  response.headersSent = true;
  await invoke(route.registered.handler, {
    method: 'GET', path: '/redkern/redis/headers-sent', query: {}, headers: {}
  }, response);
  assert.equal(response.body, undefined);

  const metricsMock = makeRED();
  const metrics = routeFor(metricsMock.value, 'GET', '/metrics-type', async (_req, res) => {
    res.text('up 1\n', 'text/plain; version=0.0.4');
  });
  metrics.registry.add('active', {});
  const rejected = makeResponse();
  await invoke(metrics.registered.handler, {
    method: 'GET', path: '/redkern/redis/metrics-type', query: {}, headers: {}
  }, rejected);
  assert.equal(rejected.statusCode, 500);
});

test('JSON facade defaults an unset status and omits absent public error codes', async () => {
  const mock = makeRED();
  const route = routeFor(mock.value, 'GET', '/default-status', async (_req, res) => res.json({ ok: true }));
  route.registry.add('active', {});
  const response = makeResponse();
  response.statusCode = 0;
  await invoke(route.registered.handler, {
    method: 'GET', path: '/redkern/redis/default-status', query: {}, headers: {}
  }, response);
  assert.equal(response.statusCode, 200);

  const noCodeMock = makeRED();
  const noCode = routeFor(noCodeMock.value, 'GET', '/public-no-code', async () => { throw new kit.PublicError(422, 'Invalid input'); });
  noCode.registry.add('active', {});
  const noCodeResponse = makeResponse();
  await invoke(noCode.registered.handler, {
    method: 'GET', path: '/redkern/redis/public-no-code', query: {}, headers: {}
  }, noCodeResponse);
  assert.deepEqual(noCodeResponse.body, { error: 'Invalid input' });
});

test('JSON UTF-8 writes use facade and sanitize public errors', async () => {
  const mock = makeRED();
  const { registry, registered } = routeFor(mock.value, 'PATCH', '/write', async (req, res) => {
    assert.equal(req.body.value, 'ok');
    throw new kit.PublicError(422, 'Invalid field', { code: 'FIELD_INVALID' });
  });
  registry.add('active', {});
  const response = makeResponse();
  await invoke(registered.handler, {
    method: 'PATCH', path: '/redkern/redis/write', query: {},
    headers: { 'content-type': 'application/json; charset=utf-8' }, body: { value: 'ok' }
  }, response);
  assert.equal(response.statusCode, 422);
  assert.deepEqual(response.body, { error: 'Invalid field', code: 'FIELD_INVALID' });
});

test('unexpected handler errors become request-id 500 without raw details', async () => {
  const mock = makeRED();
  const { registry, registered } = routeFor(mock.value, 'GET', '/failure', async () => { throw new Error('internal-secret-detail'); });
  registry.add('active', {});
  const response = makeResponse();
  await invoke(registered.handler, { method: 'GET', path: '/redkern/redis/failure', query: {}, headers: {} }, response);
  assert.equal(response.statusCode, 500);
  assert.equal(response.body.error, 'Internal error');
  assert.equal(typeof response.body.id, 'string');
  assert.equal(JSON.stringify(response.body).includes('internal-secret-detail'), false);
  assert.equal(mock.logs.some(([, message]) => message.includes('internal-secret-detail')), true);
});

test('handler failure after starting a response destroys the response', async () => {
  const mock = makeRED();
  const route = routeFor(mock.value, 'GET', '/late-failure', async (_req, res) => {
    res.json({ accepted: true });
    throw new Error('late failure');
  });
  route.registry.add('active', {});
  const response = makeResponse();
  await invoke(route.registered.handler, {
    method: 'GET', path: '/redkern/redis/late-failure', query: {}, headers: {}
  }, response);
  assert.deepEqual(response.body, { accepted: true });
  assert.equal(response.destroyed, true);
  assert.equal(mock.logs.some(([, message]) => message.includes('failed after response started')), true);
});

test('HTTP facade rejects unsafe headers and bounds handler time', async () => {
  const mock = makeRED();
  const route = routeFor(mock.value, 'GET', '/headers', async (_req, res) => res.setHeader('set-cookie', 'secret'));
  route.registry.add('active', {});
  const unsafe = makeResponse();
  await invoke(route.registered.handler, { method: 'GET', path: '/redkern/redis/headers', query: {}, headers: {} }, unsafe);
  assert.equal(unsafe.statusCode, 500);

  const slowMock = makeRED();
  let timeoutSignal;
  const slow = routeFor(slowMock.value, 'GET', '/slow', (req) => {
    timeoutSignal = req.signal;
    return new Promise(() => {});
  }, 'redkern.redis.read', 1);
  slow.registry.add('active', {});
  const timedOut = makeResponse();
  await new Promise((resolve) => {
    slow.registered.handler({ method: 'GET', path: '/redkern/redis/slow', query: {}, headers: {} }, timedOut);
    setTimeout(resolve, 10);
  });
  assert.equal(timedOut.statusCode, 504);
  assert.equal(timeoutSignal.aborted, true);
});

test('HTTP facade validates status and headers and sends only one response', async () => {
  const mock = makeRED();
  let registry;
  const route = routeFor(mock.value, 'GET', '/facade', async (_req, response) => {
    assert.throws(() => response.status(99), /invalid response status/);
    assert.throws(() => response.setHeader('bad header', 'value'), /invalid response header/);
    assert.throws(() => response.setHeader('x-trace', 'bad\r\nvalue'), /invalid response header/);
    assert.throws(() => response.setHeader('set-cookie', 'secret'), /invalid response header/);
    response.status(202).setHeader('x-trace', 'safe').text('ready');
    response.text('ignored');
    response.json({ ignored: true });
  });
  registry = route.registry;
  assert.equal(registry.size(), 0);
  registry.add('active', {});
  assert.equal(registry.size(), 1);
  const response = makeResponse();
  await invoke(route.registered.handler, { method: 'GET', path: '/redkern/redis/facade', query: {}, headers: {} }, response);
  assert.equal(response.statusCode, 202);
  assert.equal(response.headers['x-trace'], 'safe');
  assert.equal(response.body, 'ready');
});

test('HTTP disconnect aborts the handler without writing an error response', async () => {
  const mock = makeRED();
  let requestSignal;
  const route = routeFor(mock.value, 'GET', '/disconnect', (req) => {
    requestSignal = req.signal;
    return new Promise(() => {});
  });
  route.registry.add('active', {});
  const response = makeResponse();
  route.registered.handler({ method: 'GET', path: '/redkern/redis/disconnect', query: {}, headers: {} }, response);
  await new Promise((resolve) => setImmediate(resolve));
  response.emit('close');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(requestSignal.aborted, true);
  assert.equal(response.body, undefined);
  assert.equal(response.destroyed, undefined);
});

test('HTTP disconnect before dispatch is handled as an already-aborted signal', async () => {
  const mock = makeRED();
  const route = routeFor(mock.value, 'GET', '/early-disconnect', async () => assert.fail('disconnected handler must not run'));
  route.registry.add('active', {});
  const response = makeResponse();
  route.registered.handler({ method: 'GET', path: '/redkern/redis/early-disconnect', query: {}, headers: {} }, response);
  response.emit('close');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(response.body, undefined);
  assert.equal(response.destroyed, undefined);
});

test('HTTP disconnect during handler setup is observed before timeout subscription', async () => {
  const mock = makeRED();
  const response = makeResponse();
  const route = routeFor(mock.value, 'GET', '/setup-disconnect', async () => {
    response.emit('close');
    return new Promise(() => {});
  });
  route.registry.add('active', {});
  await invoke(route.registered.handler, {
    method: 'GET', path: '/redkern/redis/setup-disconnect', query: {}, headers: {}
  }, response);
  assert.equal(response.body, undefined);
  assert.equal(response.destroyed, undefined);
});