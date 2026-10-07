'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createAsync } = require('../../lib/async');

function makeAsync(overrides = {}) {
  const node = new EventEmitter();
  node.id = 'async-node';
  node.type = 'redkern-test-async';
  node.name = 'async';
  node.send = () => {};
  const controller = new AbortController();
  const logs = [];
  const statuses = [];
  const api = createAsync({
    node,
    signal: controller.signal,
    log: { error: (...args) => logs.push(['error', ...args]), warn: (...args) => logs.push(['warn', ...args]) },
    status: (...args) => statuses.push(args),
    enabled: Object.assign(() => true, { disabledReason: null }),
    lifecycle: { startState: 'idle', startError: undefined, startPromise: undefined, onDrain: () => {} },
    isClosing: () => controller.signal.aborted,
    ...overrides
  });
  return { api, node, controller, logs, statuses };
}

function input(node, msg, send = () => {}) {
  return new Promise((resolve) => node.emit('input', msg, send, resolve));
}

test('track covers success, rejection, abort rejection, and close rejection', async () => {
  const { api, controller, statuses, logs } = makeAsync();
  assert.equal(await api.track(Promise.resolve()), true);
  assert.equal(await api.track(Promise.reject(Object.assign(new Error('failed'), { code: 'EIO' }))), false);
  assert.equal(await api.track(Promise.reject(Object.assign(new Error('abort'), { name: 'AbortError' }))), false);
  controller.abort();
  assert.equal(await api.track(Promise.reject(new Error('late'))), false);
  assert.equal(statuses.length, 1);
  assert.equal(logs.length, 1);
});

test('input handles non-object messages and absent native done callback', async () => {
  const { api, node } = makeAsync();
  const sent = [];
  api.onInput(async (msg, send) => send(msg), { concurrency: 1 });
  await new Promise((resolve) => {
    node.emit('input', 'primitive', (msg) => sent.push(msg));
    setImmediate(resolve);
  });
  assert.deepEqual(sent, ['primitive']);
});

test('startup failure flushes waiting messages with NODE_START_FAILED', async () => {
  let rejectStart;
  const startPromise = new Promise((_, reject) => { rejectStart = reject; });
  const lifecycle = { startState: 'starting', startError: undefined, startPromise, onDrain: () => {} };
  const { api, node } = makeAsync({ lifecycle });
  api.onInput(async () => assert.fail('handler must not execute'), { concurrency: 1, startQueueTimeoutMs: 1000 });
  const result = input(node, {});
  lifecycle.startError = new Error('config failed');
  lifecycle.startState = 'failed';
  rejectStart(lifecycle.startError);
  assert.equal((await result).code, 'NODE_START_FAILED');
});

test('errorOutput preserves previous error and maps primitive message', async () => {
  const { api, node } = makeAsync();
  let output;
  api.onInput(async () => { throw Object.assign(new Error('failure'), { code: 'EFAIL' }); }, {
    concurrency: 1,
    errorOutput: true,
    outputCount: 2
  });
  const msg = { error: { message: 'old' } };
  await input(node, msg, (value) => { output = value; });
  assert.equal(output[0], null);
  assert.equal(output[1].payload, msg.payload);
  assert.equal(msg.error.code, 'EFAIL');
  assert.deepEqual(msg.error.previous, { message: 'old' });
});

test('errorOutput send failure falls back to native done error', async () => {
  const { api, node } = makeAsync();
  api.onInput(async () => { throw new Error('handler failure'); }, {
    concurrency: 1,
    errorOutput: true,
    outputCount: 1
  });
  const result = new Promise((resolve) => node.emit('input', {}, () => { throw new Error('send failure'); }, resolve));
  assert.equal((await result).message, 'send failure');
});

test('errorOutput sanitizes primitive errors and wraps primitive input payloads', async () => {
  const { api, node } = makeAsync();
  let output;
  api.onInput(async () => { throw 'primitive failure'; }, { concurrency: 1, errorOutput: true, outputCount: 1 });
  await input(node, null, (value) => { output = value; });
  assert.equal(output[0].payload, null);
  assert.equal(output[0].error.message, 'Operation failed');
  assert.equal(output[0].error.code, 'INPUT_ERROR');
});

test('completion guard diagnoses a native done callback that throws', async () => {
  const { api, node, logs } = makeAsync();
  api.onInput(async () => { throw new Error('handler failed'); }, {
    concurrency: 1,
    errorOutput: true,
    outputCount: 1
  });
  node.emit('input', {}, () => {}, () => { throw new Error('done failed'); });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(logs.some(([level, , options]) => level === 'warn' && options?.key === 'INPUT_ALREADY_COMPLETED'), true);
});

test('abort between dispatch and limiter execution prevents handler startup', async () => {
  const { api, node, controller } = makeAsync();
  let handlerStarted = false;
  api.onInput(() => { handlerStarted = true; }, {
    concurrency: 1,
    closeTimeoutMs: 1
  });
  const completion = new Promise((resolve) => node.emit('input', {}, () => {}, resolve));
  controller.abort();
  assert.equal((await completion).code, 'NODE_CLOSING');
  assert.equal(handlerStarted, false);
});

test('input exposes stats, closes before dispatch, and drains active work', async () => {
  const drainHooks = [];
  const lifecycle = {
    startState: 'idle',
    startError: undefined,
    startPromise: undefined,
    onDrain: (handler, options) => drainHooks.push({ handler, options })
  };
  const { api, node } = makeAsync({ lifecycle });
  let releaseWork;
  const inputApi = api.onInput(() => new Promise((resolve) => { releaseWork = resolve; }), { concurrency: 1 });
  assert.deepEqual(inputApi.stats(), { active: 0, queued: 0, closed: false, starting: 0, errors: 0 });
  const completion = new Promise((resolve) => node.emit('input', {}, undefined, resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(inputApi.stats().active, 1);
  assert.equal(drainHooks.length, 1);
  inputApi.close();
  assert.equal(inputApi.stats().closed, true);
  assert.equal((await input(node, {})).code, 'NODE_CLOSING');
  releaseWork();
  assert.equal(await completion, undefined);
  await drainHooks[0].handler({ deadline: Date.now() + 100 });
  drainHooks[0].options.force();
});

test('startup queue with zero capacity fails input immediately', async () => {
  const startPromise = new Promise(() => {});
  const lifecycle = { startState: 'starting', startError: undefined, startPromise, onDrain: () => {} };
  const { api, node } = makeAsync({ lifecycle });
  api.onInput(async () => assert.fail('handler must not execute'), {
    concurrency: 1,
    maxQueue: 0,
    startQueueTimeoutMs: 1000
  });
  assert.equal((await input(node, {})).code, 'INPUT_QUEUE_FULL');
});

test('startup success flushes queued input before its arrival deadline', async () => {
  let resolveStart;
  const startPromise = new Promise((resolve) => { resolveStart = resolve; });
  const lifecycle = { startState: 'starting', startError: undefined, startPromise, onDrain: () => {} };
  const { api, node } = makeAsync({ lifecycle });
  let processed = 0;
  api.onInput(async (message, send) => {
    processed += 1;
    send(message);
  }, { concurrency: 1, startQueueTimeoutMs: 1000 });
  let forwarded;
  const completion = new Promise((resolve) => node.emit('input', { payload: 'queued' }, (message) => { forwarded = message; }, resolve));
  lifecycle.startState = 'ready';
  resolveStart();
  await completion;
  await startPromise;
  assert.equal(processed, 1);
  assert.deepEqual(forwarded, { payload: 'queued' });
});

test('closing input while startup is pending rejects queued work when startup resolves', async () => {
  let resolveStart;
  const startPromise = new Promise((resolve) => { resolveStart = resolve; });
  const lifecycle = { startState: 'starting', startError: undefined, startPromise, onDrain: () => {} };
  const { api, node } = makeAsync({ lifecycle });
  const inputApi = api.onInput(async () => assert.fail('closed startup input must not execute'), {
    concurrency: 1,
    startQueueTimeoutMs: 1000
  });
  const completion = input(node, {});
  inputApi.close();
  lifecycle.startState = 'ready';
  resolveStart();
  assert.equal((await completion).code, 'NODE_CLOSING');
});

test('node abort flushes queued startup input with NODE_CLOSING', async () => {
  const startPromise = new Promise(() => {});
  const lifecycle = { startState: 'starting', startError: undefined, startPromise, onDrain: () => {} };
  const { api, node, controller } = makeAsync({ lifecycle });
  api.onInput(async () => assert.fail('aborted startup input must not execute'), {
    concurrency: 1,
    startQueueTimeoutMs: 1000
  });
  const completion = input(node, {});
  controller.abort();
  assert.equal((await completion).code, 'NODE_CLOSING');
});

test('input drain rejects startup-queued work before resource cleanup', async () => {
  const lifecycle = {
    startState: 'starting',
    startError: undefined,
    startPromise: new Promise(() => {}),
    onDrain(handler) { this.drain = handler; }
  };
  const { api, node } = makeAsync({ lifecycle });
  api.onInput(async () => assert.fail('drained startup input must not execute'), {
    concurrency: 1,
    startQueueTimeoutMs: 1000
  });
  const completion = input(node, {});
  await lifecycle.drain({ deadline: Date.now() + 100 });
  assert.equal((await completion).code, 'NODE_CLOSING');
});

test('input drain rejects when its shared close deadline has expired', async () => {
  let drain;
  const lifecycle = {
    startState: 'idle',
    startError: undefined,
    startPromise: undefined,
    onDrain: (handler) => { drain = handler; }
  };
  const { api } = makeAsync({ lifecycle });
  api.onInput(async () => {}, { concurrency: 1 });
  await assert.rejects(drain({ deadline: Date.now() - 1 }), { code: 'CLOSE_DRAIN_TIMEOUT' });
});

test('default tracking state, fallback send, and active input abort are covered', async () => {
  const node = new EventEmitter();
  node.id = 'default-close-node';
  node.type = 'redkern-test-async';
  node.name = 'async';
  const controller = new AbortController();
  const logs = [];
  const statuses = [];
  const sent = [];
  let drain;
  let force;
  const lifecycle = {
    startState: 'idle',
    startError: undefined,
    startPromise: undefined,
    onDrain: (handler, options) => { drain = handler; force = options.force; }
  };
  const api = createAsync({
    node,
    signal: controller.signal,
    log: { error: (...args) => logs.push(['error', ...args]), warn: (...args) => logs.push(['warn', ...args]) },
    status: (...args) => statuses.push(args),
    enabled: Object.assign(() => true, { disabledReason: null }),
    lifecycle
  });
  node.send = (message) => sent.push(message);
  assert.equal(await api.track(Promise.reject(Object.assign(new Error('background'), { code: 'EIO' }))), false);
  assert.equal(statuses.length, 1);

  let releaseWork;
  let guardedSend;
  const inputApi = api.onInput(async (_msg, send) => {
    guardedSend = send;
    send({ payload: 'fallback' });
    await new Promise((resolve) => { releaseWork = resolve; });
  }, { concurrency: 1 });
  const completion = new Promise((resolve) => node.emit('input', {}, undefined, resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(sent, [{ payload: 'fallback' }]);
  controller.abort();
  guardedSend({ payload: 'late' });
  force();
  assert.equal((await completion).code, 'NODE_CLOSING');
  releaseWork();
  await drain({ deadline: Date.now() + 100 });
  assert.equal(inputApi.stats().closed, true);
  assert.equal(logs.some(([level, , options]) => level === 'warn' && options?.key === 'INPUT_ALREADY_COMPLETED'), true);
});

test('active input overflow maps limiter rejection to INPUT_QUEUE_FULL', async () => {
  const { api, node } = makeAsync();
  let releaseWork;
  api.onInput(() => new Promise((resolve) => { releaseWork = resolve; }), { concurrency: 1, maxQueue: 0 });
  const first = input(node, { payload: 'active' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await input(node, { payload: 'overflow' })).code, 'INPUT_QUEUE_FULL');
  releaseWork();
  assert.equal(await first, undefined);
});

test('node shutdown maps queued limiter aborts to NODE_CLOSING', async () => {
  const { api, node, controller } = makeAsync();
  let releaseActive;
  api.onInput(() => new Promise((resolve) => { releaseActive = resolve; }), { concurrency: 1, maxQueue: 1 });
  const active = input(node, { payload: 'active' });
  await new Promise((resolve) => setImmediate(resolve));
  const queued = input(node, { payload: 'queued' });
  controller.abort();
  assert.equal((await queued).code, 'NODE_CLOSING');
  releaseActive();
  assert.equal(await active, undefined);
});

test('input API close maps queued limiter aborts to NODE_CLOSING', async () => {
  const { api, node } = makeAsync();
  let releaseActive;
  const inputApi = api.onInput(() => new Promise((resolve) => { releaseActive = resolve; }), {
    concurrency: 1,
    maxQueue: 1
  });
  const active = input(node, { payload: 'active' });
  await new Promise((resolve) => setImmediate(resolve));
  const queued = input(node, { payload: 'queued' });
  inputApi.close();
  assert.equal((await queued).code, 'NODE_CLOSING');
  releaseActive();
  assert.equal(await active, undefined);
});

test('close timeout completes active input once despite a later handler rejection', async () => {
  const { api, node, controller } = makeAsync();
  let rejectWork;
  let doneCalls = 0;
  api.onInput(() => new Promise((_resolve, reject) => { rejectWork = reject; }), {
    concurrency: 1,
    closeTimeoutMs: 2
  });
  const completion = new Promise((resolve) => node.emit('input', {}, () => {}, (error) => {
    doneCalls += 1;
    resolve(error);
  }));
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  assert.equal((await completion).code, 'NODE_CLOSING');
  rejectWork(new Error('late task failure'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(doneCalls, 1);
});

test('invalid node configuration and failed startup reject input before execution', async () => {
  const config = makeAsync({ configIssues: () => [{ field: 'host', code: 'REQUIRED' }] });
  config.api.onInput(async () => assert.fail('invalid config handler must not run'), { concurrency: 1 });
  assert.equal((await input(config.node, {})).code, 'NODE_START_FAILED');

  const failedLifecycle = {
    startState: 'failed',
    startError: new Error('startup rejected'),
    startPromise: Promise.reject(new Error('startup rejected')),
    onDrain: () => {}
  };
  failedLifecycle.startPromise.catch(() => {});
  const failed = makeAsync({ lifecycle: failedLifecycle });
  failed.api.onInput(async () => assert.fail('failed startup handler must not run'), {
    concurrency: 1,
    startQueueTimeoutMs: 100
  });
  assert.equal((await input(failed.node, {})).code, 'NODE_START_FAILED');
});