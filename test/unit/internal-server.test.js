'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const { EventEmitter } = require('node:events');
const { names } = require('../../lib/naming');
const { PublicError } = require('../../lib/auth');
const { createInternalServer } = require('../../lib/internal-server');
const kit = require('../..');

const TOKEN = '0123456789abcdefghijklmnopqrstuv';

function makeLogger() {
  const records = [];
  return {
    records,
    error: (...args) => records.push(['error', ...args]),
    warn: (...args) => records.push(['warn', ...args])
  };
}

async function freePort() {
  const probe = net.createServer();
  await new Promise((resolve, reject) => probe.listen(0, '127.0.0.1', (error) => error ? reject(error) : resolve()));
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

function makeServer(port, routes, tokens = {}, log = makeLogger(), handlerTimeoutMs = 100) {
  return createInternalServer({
    domainNames: names('redis'),
    port,
    routes,
    tokens,
    log,
    redact: (value) => typeof value === 'string' ? value.replaceAll(TOKEN, '[REDACTED]') : value,
    handlerTimeoutMs
  });
}

async function acquire(server, id = 'node-1') {
  const lease = server.acquire(id, {});
  await lease.ready;
  return lease;
}

test('internal server requires explicit route auth and rejects unsafe route layouts', () => {
  const port = 9554;
  assert.throws(() => createInternalServer({ domainNames: names('redis'), port: 0, routes: [], log: makeLogger() }), /port/);
  assert.throws(() => createInternalServer({ domainNames: names('redis'), port, routes: [], log: makeLogger() }), /non-empty array/);
  assert.throws(() => createInternalServer({ domainNames: names('redis'), port, routes: [{ method: 'GET', path: '/ok', auth: 'local', handler() {} }], handlerTimeoutMs: 0, log: makeLogger() }), /handlerTimeoutMs/);
  for (const route of [null, {}, { method: 'GET', path: '/ok', auth: 'local' }]) {
    assert.throws(() => makeServer(port, [route]), TypeError);
  }
  assert.throws(() => makeServer(port, [
    { method: 'GET', path: '/same', auth: 'local', handler() {} },
    { method: 'get', path: '/same', auth: 'local', handler() {} }
  ]), /duplicate internal route/);
  assert.throws(() => makeServer(port, [{ method: 'GET', path: '/health', handler() {} }]), /requires local auth or a declared token/);
  assert.throws(() => makeServer(port, [
    { method: 'GET', path: '/local', auth: 'local', handler() {} },
    { method: 'GET', path: '/metrics', auth: { token: 'metrics' }, handler() {} }
  ], { metrics: TOKEN }), /cannot share/);
  assert.throws(() => makeServer(port, [{ method: 'GET', path: '/metrics', auth: { token: 'missing' }, handler() {} }]), /declared token/);
  assert.throws(() => makeServer(port, [{ method: 'GET', path: '/:id', auth: 'local', handler() {} }]), /static absolute suffix/);
  assert.throws(() => makeServer(port, [{ method: 'TRACE', path: '/health', auth: 'local', handler() {} }]), /unsupported/);
});

test('local listener binds loopback and serves exact routes', async () => {
  const port = await freePort();
  const server = makeServer(port, [{
    method: 'GET',
    path: '/health',
    auth: 'local',
    handler: async (_req, res, entries) => {
      assert.equal(entries.set, undefined);
      assert.equal(Object.isFrozen(entries), true);
      return res.json({ healthy: true, owners: entries.size });
    }
  }]);
  assert.equal(server.host, '127.0.0.1');
  const lease = await acquire(server);
  const response = await fetch(`http://127.0.0.1:${port}/redkern/redis/health`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { healthy: true, owners: 1 });
  const missing = await fetch(`http://127.0.0.1:${port}/redkern/redis/health/extra`);
  assert.equal(missing.status, 404);
  await lease.release();
  assert.equal(server.size(), 0);
});

test('bind overlays internal listener errors and restores palette status after recovery', async () => {
  const port = await freePort();
  const occupied = net.createServer();
  await new Promise((resolve, reject) => occupied.listen(port, '127.0.0.1', (error) => error ? reject(error) : resolve()));
  const statuses = [];
  const RED = { settings: {}, log: { error() {}, warn() {}, info() {}, debug() {} } };
  const context = kit.init(RED, {
    domain: 'redis',
    statusOptions: { minIntervalMs: 0 },
    internalServer: {
      port,
      routes: [{ method: 'GET', path: '/health', auth: 'local', handler: async () => {} }]
    }
  });
  const node = new EventEmitter();
  node.id = 'status-overlay-node';
  node.status = (status) => statuses.push(status);
  const bound = context.bind(node);
  bound.status('ok', 'palette ready');
  const lease = bound.internalServer.acquire('status-overlay-owner', {});
  lease.ready.catch(() => {});
  try {
    for (let attempt = 0; attempt < 100 && !statuses.some(({ fill, text }) => fill === 'red' && text === 'EADDRINUSE'); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(statuses.some(({ fill, text }) => fill === 'red' && text === 'EADDRINUSE'), true);
    await new Promise((resolve) => occupied.close(resolve));
    await lease.ready;
    assert.deepEqual(statuses.at(-1), { fill: 'green', shape: 'dot', text: 'palette ready' });
  } finally {
    await lease.release();
    await new Promise((resolve) => node.emit('close', false, resolve));
    if (occupied.listening) await new Promise((resolve) => occupied.close(resolve));
  }
});

test('internal listener returns 503 when the active request limit is reached', async () => {
  const port = await freePort();
  let releaseHandlers;
  let entered = 0;
  let allEntered;
  const enteredLimit = new Promise((resolve) => { allEntered = resolve; });
  const handlerGate = new Promise((resolve) => { releaseHandlers = resolve; });
  const server = makeServer(port, [{
    method: 'GET',
    path: '/hold',
    auth: 'local',
    handler: async (_req, res) => {
      entered += 1;
      if (entered === 64) allEntered();
      await handlerGate;
      res.json({ ok: true });
    }
  }]);
  const lease = await acquire(server);
  const agent = new http.Agent({ keepAlive: true, maxSockets: 65 });
  let limitTimer;
  const request = () => new Promise((resolve, reject) => {
    const client = http.get(`http://127.0.0.1:${port}/redkern/redis/hold`, { agent }, (response) => {
      response.resume();
      response.on('end', () => resolve(response.statusCode));
    });
    client.setTimeout(5000, () => client.destroy(new Error('request timed out')));
    client.on('error', reject);
  });
  const active = Array.from({ length: 64 }, request);
  try {
    await Promise.race([enteredLimit, new Promise((_, reject) => { limitTimer = setTimeout(() => reject(new Error('active request limit was not reached')), 5000); })]);
    assert.equal(await request(), 503);
    releaseHandlers();
    assert.deepEqual(await Promise.all(active), Array(64).fill(200));
  } finally {
    clearTimeout(limitTimer);
    releaseHandlers();
    agent.destroy();
    await lease.release();
  }
});

test('token listener enforces authentication, JSON, body size, and public errors', async () => {
  const port = await freePort();
  const server = makeServer(port, [{
    method: 'POST',
    path: '/data',
    auth: { token: 'metrics' },
    handler: async (req, res) => {
      if (req.body?.fail) throw new PublicError(422, 'Invalid event', { code: 'EVENT_INVALID' });
      if (req.body?.failWithoutCode) throw new PublicError(422, 'Invalid event');
      res.json({ payload: req.body?.payload });
    }
  }], { metrics: TOKEN });
  assert.equal(server.host, '0.0.0.0');
  const lease = await acquire(server);
  const url = `http://127.0.0.1:${port}/redkern/redis/data`;
  const unauthorized = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(unauthorized.status, 401);
  const form = await fetch(url, { method: 'POST', headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/x-www-form-urlencoded' }, body: 'payload=x' });
  assert.equal(form.status, 415);
  const missingContentType = await fetch(url, { method: 'POST', headers: { authorization: `Bearer ${TOKEN}` } });
  assert.equal(missingContentType.status, 415);
  const accepted = await fetch(url, { method: 'POST', headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json; charset=utf-8' }, body: JSON.stringify({ payload: 'event' }) });
  assert.equal(accepted.status, 200);
  assert.deepEqual(await accepted.json(), { payload: 'event' });
  const publicFailure = await fetch(url, { method: 'POST', headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }, body: JSON.stringify({ fail: true }) });
  assert.equal(publicFailure.status, 422);
  assert.deepEqual(await publicFailure.json(), { error: 'Invalid event', code: 'EVENT_INVALID' });
  const publicFailureWithoutCode = await fetch(url, { method: 'POST', headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }, body: JSON.stringify({ failWithoutCode: true }) });
  assert.equal(publicFailureWithoutCode.status, 422);
  assert.deepEqual(await publicFailureWithoutCode.json(), { error: 'Invalid event' });
  const oversized = await fetch(url, { method: 'POST', headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }, body: `"${'x'.repeat(1024 * 1024 + 1)}"` });
  assert.equal(oversized.status, 413);
  await lease.release();
});

test('internal dispatch contains code-less request stream errors with sent and unsent responses', async () => {
  const port = await freePort();
  const originalCreateServer = http.createServer;
  const instance = new EventEmitter();
  let dispatch;
  instance.listening = false;
  instance.listen = () => {
    instance.listening = true;
    setImmediate(() => instance.emit('listening'));
    return instance;
  };
  instance.close = (callback) => {
    instance.listening = false;
    setImmediate(() => { callback?.(); instance.emit('close'); });
    return instance;
  };
  http.createServer = (_options, handler) => { dispatch = handler; return instance; };
  const log = makeLogger();
  let lease;

  function makeRequest() {
    const request = new EventEmitter();
    request.url = '/redkern/redis/broken';
    request.method = 'POST';
    request.headers = { 'content-length': '1', 'content-type': 'application/json' };
    request.socket = { remoteAddress: '127.0.0.1' };
    request[Symbol.asyncIterator] = async function* () { throw new Error('stream failed'); };
    return request;
  }

  function makeResponse(headersSent = false) {
    const response = new EventEmitter();
    response.headersSent = headersSent;
    response.writableEnded = false;
    response.statusCode = 200;
    response.destroyed = false;
    response.destroy = () => { response.destroyed = true; };
    response.writeHead = (statusCode, headers) => {
      response.statusCode = statusCode;
      response.headers = headers;
      response.headersSent = true;
    };
    response.end = (body) => {
      response.body = body;
      response.writableEnded = true;
    };
    return response;
  }

  try {
    const server = makeServer(port, [{ method: 'POST', path: '/broken', auth: 'local', handler: async () => assert.fail('stream failure must prevent handler') }], {}, log);
    lease = server.acquire('stream-error-owner', {});
    await lease.ready;

    const unsent = makeResponse();
    await dispatch(makeRequest(), unsent);
    assert.equal(unsent.statusCode, 400);
    assert.deepEqual(JSON.parse(unsent.body), { error: 'Invalid request', code: 'INVALID_REQUEST' });
    assert.equal(log.records.some(([level, error, options]) => level === 'error' && error.message === 'stream failed' && options.key === 'INTERNAL_REQUEST_FAILED'), true);

    const sent = makeResponse(true);
    await dispatch(makeRequest(), sent);
    assert.equal(sent.destroyed, true);
  } finally {
    http.createServer = originalCreateServer;
    if (lease) await lease.release();
  }
});

test('internal body parser rejects malformed JSON, encodings, and unsupported charsets', async () => {
  const port = await freePort();
  const server = makeServer(port, [
    { method: 'POST', path: '/body', auth: 'local', handler: async (req, res) => res.json({ body: req.body }) },
    { method: 'DELETE', path: '/delete', auth: 'local', handler: async (_req, res) => res.json({ deleted: true }) }
  ]);
  const lease = await acquire(server);
  try {
    const base = `http://127.0.0.1:${port}/redkern/redis`;
    const malformed = await fetch(`${base}/body`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{' });
    assert.equal(malformed.status, 400);
    assert.equal((await malformed.json()).code, 'INVALID_JSON');
    const malformedContentType = await fetch(`${base}/body`, { method: 'POST', headers: { 'content-type': 'application/json; charset' }, body: '{}' });
    assert.equal(malformedContentType.status, 415);
    const identity = await fetch(`${base}/body`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-encoding': 'identity' },
      body: JSON.stringify({ identity: true })
    });
    assert.deepEqual(await identity.json(), { body: { identity: true } });
    const emptyChunked = await new Promise((resolve, reject) => {
      const request = http.request(`${base}/body`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'transfer-encoding': 'chunked' }
      }, (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
      });
      request.on('error', reject);
      request.end();
    });
    assert.equal(emptyChunked.status, 200);
    assert.deepEqual(JSON.parse(emptyChunked.body), {});
    const encoded = await fetch(`${base}/body`, { method: 'POST', headers: { 'content-type': 'application/json', 'content-encoding': 'gzip' }, body: '{}' });
    assert.equal(encoded.status, 415);
    assert.equal((await encoded.json()).code, 'UNSUPPORTED_ENCODING');
    const charset = await fetch(`${base}/body`, { method: 'POST', headers: { 'content-type': 'application/json; charset=iso-8859-1' }, body: '{}' });
    assert.equal(charset.status, 415);
    const duplicateCharset = await fetch(`${base}/body`, { method: 'POST', headers: { 'content-type': 'application/json; charset=utf-8; charset=utf-8' }, body: '{}' });
    assert.equal(duplicateCharset.status, 415);
    const deleted = await fetch(`${base}/delete`, { method: 'DELETE' });
    assert.deepEqual(await deleted.json(), { deleted: true });
    const invalidDelete = await fetch(`${base}/delete`, { method: 'DELETE', headers: { 'content-type': 'text/plain' }, body: 'x' });
    assert.equal(invalidDelete.status, 415);

    const chunked = await new Promise((resolve, reject) => {
      const request = http.request(`${base}/body`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'transfer-encoding': 'chunked' }
      }, (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
      });
      request.on('error', reject);
      request.end(`"${'x'.repeat(1024 * 1024 + 1)}"`);
    });
    assert.equal(chunked.status, 413);
    assert.equal(JSON.parse(chunked.body).code, 'BODY_TOO_LARGE');
  } finally {
    await lease.release();
  }
});

test('internal response facade preserves first response and rejects invalid status or text', async () => {
  const port = await freePort();
  const server = makeServer(port, [
    { method: 'GET', path: '/once', auth: 'local', handler: async (_req, res) => { assert.equal(res.responded, false); res.json({ value: 1 }); assert.equal(res.responded, true); res.json({ value: 2 }); } },
    { method: 'GET', path: '/once-text', auth: 'local', handler: async (_req, res) => { res.text('first'); res.text('second'); } },
    { method: 'GET', path: '/status', auth: 'local', handler: async (_req, res) => res.status(99) },
    { method: 'GET', path: '/text', auth: 'local', handler: async (_req, res) => res.text(42) },
    { method: 'GET', path: '/header', auth: 'local', handler: async (_req, res) => res.setHeader('set-cookie', 'unsafe') },
    { method: 'GET', path: '/metrics', auth: 'local', handler: async (_req, res) => res.text('up 1\n', 'text/plain; version=0.0.4') },
    { method: 'GET', path: '/valid', auth: 'local', handler: async (_req, res) => res.status(202).setHeader('x-result', 'safe').json({ ok: true }) },
    { method: 'GET', path: '/no-response', auth: 'local', handler: async () => {} },
    { method: 'GET', path: '/late-failure', auth: 'local', handler: async (_req, res) => { res.json({ accepted: true }); throw new Error('late failure'); } }
  ]);
  const lease = await acquire(server);
  try {
    const base = `http://127.0.0.1:${port}/redkern/redis`;
    const once = await fetch(`${base}/once`);
    assert.deepEqual(await once.json(), { value: 1 });
    const onceText = await fetch(`${base}/once-text`);
    assert.equal(await onceText.text(), 'first');
    assert.equal((await fetch(`${base}/status`)).status, 500);
    assert.equal((await fetch(`${base}/text`)).status, 500);
    assert.equal((await fetch(`${base}/header`)).status, 500);
    assert.equal((await fetch(`${base}/metrics`)).status, 500);
    const valid = await fetch(`${base}/valid`);
    assert.equal(valid.status, 202);
    assert.equal(valid.headers.get('x-result'), 'safe');
    assert.deepEqual(await valid.json(), { ok: true });
    const noResponse = await fetch(`${base}/no-response`);
    assert.equal(noResponse.status, 500);
    assert.equal(typeof (await noResponse.json()).id, 'string');

    const originalDestroy = http.ServerResponse.prototype.destroy;
    let destroys = 0;
    http.ServerResponse.prototype.destroy = function (...args) {
      destroys += 1;
      return originalDestroy.apply(this, args);
    };
    try {
      await fetch(`${base}/late-failure`).catch(() => {});
      assert.equal(destroys, 1);
    } finally {
      http.ServerResponse.prototype.destroy = originalDestroy;
    }
  } finally {
    await lease.release();
  }
});

test('client disconnect aborts the internal handler signal', async () => {
  const port = await freePort();
  let signal;
  let markStarted;
  const started = new Promise((resolve) => { markStarted = resolve; });
  const server = makeServer(port, [{
    method: 'GET',
    path: '/slow',
    auth: 'local',
    handler: (req) => {
      signal = req.signal;
      markStarted();
      return new Promise(() => {});
    }
  }]);
  const lease = await acquire(server);
  const controller = new AbortController();
  const request = fetch(`http://127.0.0.1:${port}/redkern/redis/slow`, { signal: controller.signal });
  await started;
  controller.abort();
  await assert.rejects(request, { name: 'AbortError' });
  for (let attempt = 0; attempt < 20 && !signal.aborted; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(signal.aborted, true);
  await lease.release();
});

test('last lease force-closes active connections after the close timeout', async () => {
  const port = await freePort();
  let markStarted;
  const started = new Promise((resolve) => { markStarted = resolve; });
  const server = createInternalServer({
    domainNames: names('redis'),
    port,
    routes: [{
      method: 'GET',
      path: '/slow-close',
      auth: 'local',
      handler: () => { markStarted(); return new Promise(() => {}); }
    }],
    log: { error() {}, warn() {} },
    handlerTimeoutMs: 60000
  });
  const lease = await acquire(server);
  const request = fetch(`http://127.0.0.1:${port}/redkern/redis/slow-close`);
  request.catch(() => {});
  await started;
  const originalSetTimeout = global.setTimeout;
  global.setTimeout = (callback, delay, ...args) => originalSetTimeout(callback, Math.min(delay, 5), ...args);
  try {
    assert.equal(await lease.release(), true);
  } finally {
    global.setTimeout = originalSetTimeout;
  }
  await assert.rejects(request);
});

test('handler timeout aborts its signal and returns a gateway timeout', async () => {
  const port = await freePort();
  let signal;
  const server = makeServer(port, [{
    method: 'GET',
    path: '/timeout',
    auth: 'local',
    handler: (req) => {
      signal = req.signal;
      return new Promise(() => {});
    }
  }], {}, makeLogger(), 20);
  const lease = await acquire(server);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/redkern/redis/timeout`);
    assert.equal(response.status, 504);
    assert.equal((await response.json()).error, 'Internal error');
    assert.equal(signal.aborted, true);
  } finally {
    await lease.release();
  }
});

test('internal leases are unique, ready rejects when released before listen', async () => {
  const port = await freePort();
  const server = makeServer(port, [{ method: 'GET', path: '/health', auth: 'local', handler: async (_req, res) => res.json({ ok: true }) }]);
  assert.equal(await server.release('missing'), false);
  const lease = await acquire(server, 'owner');
  assert.throws(() => server.acquire('owner', {}), /already exists/);
  assert.equal(await lease.release(), true);
  assert.equal(await lease.release(), false);
});

test('releasing the first lease before listen closes startup and rejects ready', async () => {
  const port = await freePort();
  const server = makeServer(port, [{ method: 'GET', path: '/health', auth: 'local', handler: async () => {} }]);
  const lease = server.acquire('early-owner', {});
  const releasing = lease.release();
  await assert.rejects(lease.ready, { code: 'INTERNAL_SERVER_CLOSED' });
  assert.equal(await releasing, true);
  assert.equal(server.size(), 0);
});

test('listen conflict reports owner status and releasing last lease rejects pending ready', async () => {
  const occupied = net.createServer();
  await new Promise((resolve, reject) => occupied.listen(0, '127.0.0.1', (error) => error ? reject(error) : resolve()));
  const port = occupied.address().port;
  const states = [];
  const server = createInternalServer({
    domainNames: names('redis'),
    port,
    routes: [{ method: 'GET', path: '/health', auth: 'local', handler: async () => {} }],
    log: { error: () => {}, warn: () => {} },
    tokens: {}
  });
  const stopListening = server.onStatus('owner', (state, text) => states.push([state, text]));
  const lease = server.acquire('owner', {});
  for (let attempt = 0; attempt < 20 && states.length === 0; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(states[0][0], 'error');
  const releasing = lease.release();
  await assert.rejects(lease.ready, { code: 'INTERNAL_SERVER_CLOSED' });
  await releasing;
  stopListening();
  await new Promise((resolve) => occupied.close(resolve));
});

test('startup promise failure rejects readiness and is logged by its observer', async () => {
  const occupied = net.createServer();
  await new Promise((resolve, reject) => occupied.listen(0, '127.0.0.1', (error) => error ? reject(error) : resolve()));
  const port = occupied.address().port;
  let errorCalls = 0;
  const server = createInternalServer({
    domainNames: names('redis'),
    port,
    routes: [{ method: 'GET', path: '/health', auth: 'local', handler: async () => {} }],
    log: {
      error() {
        errorCalls += 1;
        if (errorCalls === 1) throw new Error('logger failed during listen error');
      },
      warn() {}
    }
  });
  const lease = server.acquire('owner', {});
  await assert.rejects(lease.ready, /logger failed during listen error/);
  assert.equal(await lease.release(), true);
  assert.equal(errorCalls, 2);
  await new Promise((resolve) => occupied.close(resolve));
});

test('synchronous listen failure is reported and retried before readiness', async () => {
  const port = await freePort();
  const originalListen = net.Server.prototype.listen;
  let listenFailures = 0;
  const log = makeLogger();
  const server = makeServer(port, [{ method: 'GET', path: '/health', auth: 'local', handler: async (_req, res) => res.json({ ok: true }) }], {}, log);
  net.Server.prototype.listen = function (...args) {
    if (listenFailures === 0) {
      listenFailures += 1;
      throw new Error('synchronous listen failure');
    }
    return originalListen.apply(this, args);
  };
  const lease = server.acquire('owner', {});
  try {
    await lease.ready;
    assert.equal(listenFailures, 1);
    assert.equal(log.records.some(([level, error, options]) => level === 'error' && error?.message === 'synchronous listen failure' && options?.key === 'INTERNAL_SERVER_LISTEN'), true);
  } finally {
    net.Server.prototype.listen = originalListen;
    await lease.release();
  }
});

test('internal server rethrows non-abort retry sleep failures', async () => {
  const port = await freePort();
  const originalListen = net.Server.prototype.listen;
  const originalSetTimeout = global.setTimeout;
  net.Server.prototype.listen = () => { throw new Error('listen unavailable'); };
  global.setTimeout = () => {
    global.setTimeout = originalSetTimeout;
    throw new Error('retry sleep unavailable');
  };
  const server = makeServer(port, [{ method: 'GET', path: '/health', auth: 'local', handler: async () => {} }]);
  const lease = server.acquire('retry-error-owner', {});
  try {
    await assert.rejects(lease.ready, /retry sleep unavailable/);
  } finally {
    net.Server.prototype.listen = originalListen;
    global.setTimeout = originalSetTimeout;
    await lease.release();
  }
});

test('unexpected listener error publishes status and retries while owners remain', async () => {
  const port = await freePort();
  const originalCreateServer = http.createServer;
  let instance;
  http.createServer = (...args) => {
    instance = originalCreateServer(...args);
    return instance;
  };
  const log = makeLogger();
  const states = [];
  const server = createInternalServer({
    domainNames: names('redis'),
    port,
    routes: [{ method: 'GET', path: '/health', auth: 'local', handler: async (_req, res) => res.json({ ok: true }) }],
    log
  });
  const unsubscribe = server.onStatus('owner', (state, text) => states.push([state, text]));
  const lease = server.acquire('owner', {});
  try {
    await lease.ready;
    assert.equal(instance.listening, true);
    instance.emit('error', new Error('injected listener failure'));
    for (let attempt = 0; attempt < 100 && !states.some(([state]) => state === 'error'); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(states.some(([state]) => state === 'error'), true);
    assert.equal(log.records.some(([level, error, options]) => level === 'error' && error?.message === 'injected listener failure' && options?.key === 'INTERNAL_SERVER_ERROR'), true);
  } finally {
    http.createServer = originalCreateServer;
    unsubscribe();
    await lease.release();
  }
});

test('server cleanup handles failure after the listener starts without an error code', async () => {
  const originalCreateServer = http.createServer;
  let failCloseRegistration = true;
  const log = makeLogger();
  const states = [];
  http.createServer = (...args) => {
    const instance = originalCreateServer(...args);
    const originalOnce = instance.once;
    instance.once = function (event, listener) {
      if (event === 'close' && this.listening && failCloseRegistration) {
        failCloseRegistration = false;
        throw new Error('close listener registration failed');
      }
      return originalOnce.call(this, event, listener);
    };
    return instance;
  };
  const server = makeServer(await freePort(), [{ method: 'GET', path: '/health', auth: 'local', handler: async () => {} }], {}, log);
  const stop = server.onStatus('owner', (state, text) => states.push([state, text]));
  const lease = server.acquire('owner', {});
  try {
    await lease.ready;
    for (let attempt = 0; attempt < 50 && !log.records.some(([, error]) => error?.message === 'close listener registration failed'); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(log.records.some(([level, error, options]) => level === 'error' && error?.message === 'close listener registration failed' && options?.key === 'INTERNAL_SERVER_LISTEN'), true);
    assert.equal(states.some(([state, text]) => state === 'error' && text === 'INTERNAL LISTEN'), true);
  } finally {
    http.createServer = originalCreateServer;
    stop();
    await lease.release();
  }
});

test('listener retries after bind conflict and shares one listener across owners', async () => {
  const occupied = net.createServer();
  await new Promise((resolve, reject) => occupied.listen(0, '127.0.0.1', (error) => error ? reject(error) : resolve()));
  const port = occupied.address().port;
  const log = makeLogger();
  const server = makeServer(port, [{ method: 'GET', path: '/health', auth: 'local', handler: async (_req, res) => res.json({ ok: true }) }], {}, log);
  const states = [];
  assert.throws(() => server.acquire('', {}), /owner id/);
  assert.throws(() => server.onStatus('', () => {}), /owner id/);
  const stop = server.onStatus('status-owner', () => { throw new Error('status listener failed'); });
  assert.throws(() => server.onStatus('status-owner', () => {}), /already exists/);
  const lease = server.acquire('owner-1', {});
  try {
    for (let attempt = 0; attempt < 40 && !log.records.some(([level]) => level === 'error'); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(log.records.some(([, error]) => error?.code === 'EADDRINUSE'), true);
    await new Promise((resolve) => occupied.close(resolve));
    for (let attempt = 0; attempt < 300 && !log.records.some(([, error]) => error?.message === 'status listener failed'); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await lease.ready;
    const second = server.acquire('owner-2', {});
    assert.equal(await second.ready, undefined);
    assert.equal(server.size(), 2);
    assert.equal(await lease.release(), true);
    assert.equal(server.size(), 1);
    assert.equal(await lease.release(), false);
    assert.equal(await second.release(), true);
    assert.equal(server.size(), 0);
    assert.equal(log.records.some(([, error]) => error?.message === 'status listener failed'), true);
  } finally {
    stop();
    stop();
    await new Promise((resolve) => occupied.close(() => resolve()));
    await lease.release();
  }
});

test('init binds local internal routes and releases the listener with the node lease', async () => {
  const port = await freePort();
  const logs = [];
  const RED = {
    settings: {},
    events: new EventEmitter(),
    log: Object.fromEntries(['error', 'warn', 'info', 'debug'].map((level) => [level, (message) => logs.push([level, message])]))
  };
  const rk = kit.init(RED, {
    domain: 'redis',
    internalServer: {
      port,
      routes: [{ method: 'GET', path: '/health', auth: 'local', handler: async (_req, res, entries) => res.json({ owners: entries.size }) }]
    }
  });
  const node = new EventEmitter();
  node.id = 'internal-node';
  node.type = 'redkern-redis-source';
  node.name = 'source';
  node.status = () => {};
  node.error = node.warn = node.log = node.debug = () => {};
  const context = rk.bind(node);
  const lease = context.internalServer.acquire('source', { id: 'source' });
  assert.throws(() => context.internalServer.acquire('source', {}), /already acquired/);
  await lease.ready;
  const response = await fetch(`http://127.0.0.1:${port}/redkern/redis/health`);
  assert.deepEqual(await response.json(), { owners: 1 });
  assert.equal(await context.internalServer.release('source'), true);
  assert.equal(await context.internalServer.release('source'), false);
  await new Promise((resolve) => node.emit('close', false, resolve));
  assert.equal(await lease.release(), false);
});

test('init requires and uses a distinct declared token for token routes', async () => {
  const port = await freePort();
  const token = '0123456789abcdefghijklmnopqrstuv';
  const previousPort = process.env.REDKERN_REDIS_INTERNAL_PORT;
  const previousToken = process.env.REDKERN_REDIS_DRAIN_TOKEN;
  process.env.REDKERN_REDIS_INTERNAL_PORT = String(port);
  process.env.REDKERN_REDIS_DRAIN_TOKEN = token;
  try {
    const RED = {
      settings: {},
      events: new EventEmitter(),
      log: Object.fromEntries(['error', 'warn', 'info', 'debug'].map((level) => [level, () => {}]))
    };
    assert.throws(() => kit.init(RED, {
      domain: 'redis',
      internalServer: { port, routes: [{ method: 'GET', path: '/private', auth: { token: 'drain' }, handler: async () => {} }] }
    }), /must be declared in secrets/);
    const rk = kit.init(RED, {
      domain: 'redis',
      secrets: { drain: { required: true } },
      internalServer: {
        port,
        routes: [{ method: 'POST', path: '/private', auth: { token: 'drain' }, handler: async (_req, res) => res.json({ ok: true }) }]
      }
    });
    const node = new EventEmitter();
    Object.assign(node, { id: 'token-node', type: 'redkern-redis-config', name: 'config', status: () => {}, error() {}, warn() {}, log() {}, debug() {} });
    const context = rk.bind(node);
    const lease = context.internalServer.acquire('drain-owner', {});
    await lease.ready;
    const url = `http://127.0.0.1:${port}/redkern/redis/private`;
    const denied = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(denied.status, 401);
    const accepted = await fetch(url, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: '{}' });
    assert.deepEqual(await accepted.json(), { ok: true });
    await new Promise((resolve) => node.emit('close', false, resolve));
  } finally {
    if (previousPort === undefined) delete process.env.REDKERN_REDIS_INTERNAL_PORT;
    else process.env.REDKERN_REDIS_INTERNAL_PORT = previousPort;
    if (previousToken === undefined) delete process.env.REDKERN_REDIS_DRAIN_TOKEN;
    else process.env.REDKERN_REDIS_DRAIN_TOKEN = previousToken;
  }
});

test('internal response facade allows only the palette-declared metrics content type', async () => {
  const port = await freePort();
  const contentType = 'text/plain; version=0.0.4; charset=utf-8';
  const server = createInternalServer({
    domainNames: names('redis'),
    port,
    metricsContentType: contentType,
    routes: [{ method: 'GET', path: '/metrics', auth: 'local', handler: async (_req, res) => res.text('up 1\n', contentType) }],
    log: { error() {}, warn() {} }
  });
  const lease = await acquire(server);
  const response = await fetch(`http://127.0.0.1:${port}/redkern/redis/metrics`);
  assert.equal(await response.text(), 'up 1\n');
  assert.equal(response.headers.get('content-type'), contentType);
  await lease.release();

  const unsafePort = await freePort();
  const unsafe = createInternalServer({
    domainNames: names('redis'),
    port: unsafePort,
    routes: [{ method: 'GET', path: '/metrics', auth: 'local', handler: async (_req, res) => res.text('# EOF\n', 'application/openmetrics-text; version=1.0.0') }],
    log: { error() {}, warn() {} }
  });
  const unsafeLease = await acquire(unsafe);
  const rejected = await fetch(`http://127.0.0.1:${unsafePort}/redkern/redis/metrics`);
  assert.equal(rejected.status, 500);
  await unsafeLease.release();
});