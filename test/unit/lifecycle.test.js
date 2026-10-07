'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createLifecycle } = require('../../lib/lifecycle');

function makeLifecycle(timeoutMs = 20) {
  const controller = new AbortController();
  const logs = [];
  const states = [];
  const log = {
    error: (error, options) => logs.push(['error', error, options]),
    warn: (message, options) => logs.push(['warn', message, options])
  };
  const lifecycle = createLifecycle({
    signal: controller.signal,
    abort: () => controller.abort(),
    log,
    status: (...args) => states.push(args),
    timeoutMs,
    attemptCleanupMs: timeoutMs
  });
  return { lifecycle, logs, states, signal: controller.signal };
}

function close(lifecycle) {
  return new Promise((resolve, reject) => lifecycle.close((error) => error ? reject(error) : resolve()));
}

test('close rejects invalid handlers and registration after closing', async () => {
  const { lifecycle } = makeLifecycle();
  assert.throws(() => lifecycle.onClose(null), /function/);
  await close(lifecycle);
  assert.throws(() => lifecycle.onClose(() => {}), /after shutdown/);
});

test('close timeout forces the in-flight and skipped LIFO resources', async () => {
  const { lifecycle, logs } = makeLifecycle(5);
  const forced = [];
  lifecycle.onClose(() => forced.push('old'), { force: () => forced.push('old-force') });
  lifecycle.onClose(() => new Promise(() => {}), { force: () => forced.push('slow-force') });
  await close(lifecycle);
  assert.deepEqual(forced, ['slow-force', 'old-force']);
  assert.equal(logs.some(([level, error]) => level === 'error' && error.code === 'CLOSE_TIMEOUT'), true);
});

test('failed force stops startup retry when cleanup is not confirmed', async () => {
  const { lifecycle } = makeLifecycle();
  let attempts = 0;
  await lifecycle.onStart(async (attempt) => {
    attempts += 1;
    attempt.onClose(async () => { throw new Error('cannot clean'); });
    throw new Error('connect failed');
  });
  assert.equal(attempts, 1);
  assert.equal(lifecycle.startError.code, 'START_CLEANUP_FAILED');
  assert.equal(lifecycle.startState, 'failed');
  await close(lifecycle);
});

test('successful force permits retry and classifier failures stop startup', async () => {
  const { lifecycle } = makeLifecycle();
  let attempts = 0;
  await lifecycle.onStart(async (attempt) => {
    attempts += 1;
    if (attempts === 1) {
      attempt.onClose(async () => { throw new Error('close failed'); }, { force() {} });
      throw Object.assign(new Error('temporary'), { code: 'ECONNREFUSED' });
    }
  }, { classify: () => 'transient' });
  assert.equal(attempts, 2);
  assert.equal(lifecycle.startState, 'ready');
  await close(lifecycle);

  const invalid = makeLifecycle();
  await invalid.lifecycle.onStart(async () => { throw new Error('failure'); }, { classify: () => 'unknown' });
  assert.equal(invalid.lifecycle.startError.code, 'START_CLASSIFIER_INVALID');
  await close(invalid.lifecycle);
});

test('late attempt cleanup is forced and classifier exceptions are contained', async () => {
  const { lifecycle, logs } = makeLifecycle();
  let lateForce = false;
  let savedAttempt;
  await lifecycle.onStart(async (attempt) => { savedAttempt = attempt; });
  savedAttempt.onClose(() => {}, { force: () => { lateForce = true; } });
  assert.equal(lateForce, true);
  assert.equal(logs.some(([, , options]) => options?.key === 'LATE_RESOURCE_REGISTRATION'), true);
  await close(lifecycle);

  const invalid = makeLifecycle();
  await invalid.lifecycle.onStart(async () => { throw new Error('failure'); }, {
    classify: () => { throw new Error('classifier'); }
  });
  assert.equal(invalid.lifecycle.startError.code, 'START_CLASSIFIER_INVALID');
  await close(invalid.lifecycle);
});

test('drain failure is forced once and close receives removal context', async () => {
  const { lifecycle, logs } = makeLifecycle();
  let forced = 0;
  let removed;
  lifecycle.onDrain(async () => { throw Object.assign(new Error('drain failed'), { code: 'DRAIN_FAILED' }); }, {
    force() { forced += 1; }
  });
  lifecycle.onClose((context) => { removed = context.removed; });
  let callbackCount = 0;
  await new Promise((resolve) => lifecycle.close((error) => {
    assert.equal(error, undefined);
    callbackCount += 1;
    resolve();
  }, true));
  assert.equal(forced, 1);
  assert.equal(removed, true);
  assert.equal(callbackCount, 1);
  assert.equal(logs.some(([, error]) => error.code === 'DRAIN_FAILED'), true);
});

test('drain force exceptions after rejection are logged and do not stop cleanup', async () => {
  const { lifecycle, logs } = makeLifecycle();
  let cleaned = false;
  lifecycle.onDrain(async () => { throw new Error('drain rejected'); }, {
    force() { throw new Error('drain force failed'); }
  });
  lifecycle.onClose(() => { cleaned = true; });
  await close(lifecycle);
  assert.equal(cleaned, true);
  assert.equal(logs.some(([, error, options]) => error.message === 'drain force failed' && options.key === 'CLOSE_DRAIN_FORCE_FAILED'), true);
});

test('expired drain force exceptions are logged', async () => {
  const { lifecycle, logs } = makeLifecycle(10);
  lifecycle.onDrain(() => assert.fail('expired drain must not run'), {
    force() { throw new Error('expired drain force failed'); }
  });
  const originalNow = Date.now;
  let calls = 0;
  Date.now = () => calls++ === 0 ? 100 : 111;
  try {
    await close(lifecycle);
  } finally {
    Date.now = originalNow;
  }
  assert.equal(logs.some(([, error, options]) => error.message === 'expired drain force failed' && options.key === 'CLOSE_DRAIN_FORCE_FAILED'), true);
});

test('close continues after a throwing force handler and applies each force once', async () => {
  const { lifecycle, logs } = makeLifecycle(1);
  const forced = [];
  lifecycle.onClose(() => forced.push('older-handler'), { force: () => forced.push('older-force') });
  lifecycle.onClose(() => new Promise(() => {}), {
    force() {
      forced.push('throwing');
      throw new Error('force failed');
    }
  });
  await close(lifecycle);
  assert.deepEqual(forced, ['throwing', 'older-force']);
  assert.equal(logs.some(([, error]) => error.message === 'force failed'), true);
});

test('startup validates registration options and contains late cleanup failures', async () => {
  const { lifecycle, logs } = makeLifecycle();
  assert.throws(() => lifecycle.onStart(null), /function/);
  assert.throws(() => lifecycle.onStart(() => {}, { startAlertMs: 0 }), /startAlertMs/);
  let savedAttempt;
  await lifecycle.onStart(async (attempt) => { savedAttempt = attempt; });
  assert.throws(() => lifecycle.onStart(async () => {}), /only be registered once/);
  assert.equal(lifecycle.startState, 'ready');
  assert.throws(() => savedAttempt.onClose(null), /function/);
  savedAttempt.onClose(() => {}, { force() { throw new Error('late force failed'); } });
  assert.equal(logs.some(([, error]) => error.message === 'late force failed'), true);
  assert.throws(() => lifecycle.onDrain(null), /function/);
  await close(lifecycle);
});

test('concurrent close callers share cleanup and preserve an already-aborted signal', async () => {
  const controller = new AbortController();
  controller.abort();
  let abortCalls = 0;
  let cleanupCalls = 0;
  const lifecycle = createLifecycle({
    signal: controller.signal,
    abort: () => { abortCalls += 1; },
    log: { error() {}, warn() {} },
    status() {},
    timeoutMs: 50
  });
  lifecycle.onClose(() => { cleanupCalls += 1; });
  let callbacks = 0;
  const first = new Promise((resolve, reject) => lifecycle.close((error) => {
    if (error) reject(error);
    else { callbacks += 1; resolve(); }
  }));
  const second = new Promise((resolve, reject) => lifecycle.close((error) => {
    if (error) reject(error);
    else { callbacks += 1; resolve(); }
  }));
  await Promise.all([first, second]);
  assert.equal(abortCalls, 0);
  assert.equal(cleanupCalls, 1);
  assert.equal(callbacks, 2);
  assert.equal(lifecycle.isClosing, true);
});

test('external abort during startup prevents readiness without lifecycle close', async () => {
  const controller = new AbortController();
  const lifecycle = createLifecycle({ signal: controller.signal, abort() {}, log: { error() {}, warn() {} }, status() {} });
  let finish;
  const start = lifecycle.onStart(() => new Promise((resolve) => { finish = resolve; }));
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  finish();
  await start;
  assert.equal(lifecycle.startState, 'starting');
  await close(lifecycle);
});

test('external abort during startup suppresses the subsequent startup rejection', async () => {
  const controller = new AbortController();
  const logs = [];
  const lifecycle = createLifecycle({
    signal: controller.signal,
    abort() {},
    log: { error: (...args) => logs.push(args), warn() {} },
    status() {}
  });
  let rejectStart;
  const start = lifecycle.onStart(() => new Promise((_, reject) => { rejectStart = reject; }));
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  rejectStart(new Error('late startup rejection'));
  await start;
  assert.equal(lifecycle.startState, 'starting');
  assert.equal(logs.length, 0);
  await close(lifecycle);
});

test('default close callback, startup getter, and drains without force are covered', async () => {
  const { lifecycle, logs } = makeLifecycle();
  assert.equal(lifecycle.startPromise, undefined);
  await lifecycle.onStart(async () => {});
  assert.equal(typeof lifecycle.startPromise?.then, 'function');
  lifecycle.onDrain(async () => { throw new Error('drain without force'); });
  await lifecycle.close();
  assert.throws(() => lifecycle.onDrain(() => {}), /after shutdown/);
  assert.equal(logs.some(([, error]) => error.message === 'drain without force'), true);
});

test('drain timeout forces the drain and continues resource cleanup', async () => {
  const { lifecycle, logs } = makeLifecycle(10);
  let forced = 0;
  let cleaned = false;
  lifecycle.onDrain(() => new Promise(() => {}), { force: () => { forced += 1; } });
  lifecycle.onClose(() => { cleaned = true; }, { force: () => { cleaned = true; } });
  await close(lifecycle);
  assert.equal(forced, 1);
  assert.equal(cleaned, true);
  assert.equal(logs.some(([, error]) => error.code === 'CLOSE_DRAIN_TIMEOUT'), true);
});

test('expired close deadline forces later drains and bounds startup wait', async () => {
  const { lifecycle, logs } = makeLifecycle(25);
  let firstForced = 0;
  let laterForced = 0;
  lifecycle.onDrain(() => new Promise(() => {}), { force: () => { firstForced += 1; } });
  lifecycle.onDrain(() => assert.fail('expired drain must not run'), { force: () => { laterForced += 1; } });
  lifecycle.onStart(() => new Promise(() => {}));
  await new Promise((resolve) => setImmediate(resolve));
  await close(lifecycle);
  assert.equal(firstForced, 1);
  assert.equal(laterForced, 1);
  assert.equal(logs.some(([, error]) => error.code === 'CLOSE_START_TIMEOUT'), true);
});

test('startup classifier handles config, auth, abort, and late fallback cleanup', async () => {
  const config = makeLifecycle();
  let configAttempts = 0;
  await config.lifecycle.onStart(async () => {
    configAttempts += 1;
    throw Object.assign(new Error('invalid config'), { code: 'CONFIG_INVALID' });
  }, { classify: () => 'config' });
  assert.equal(configAttempts, 1);
  assert.equal(config.lifecycle.startState, 'failed');
  await close(config.lifecycle);

  const auth = makeLifecycle();
  const authStart = auth.lifecycle.onStart(async () => { throw new Error('credentials rejected'); }, { classify: () => 'auth' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(auth.lifecycle.startState, 'starting');
  assert.equal(auth.states.some(([state]) => state === 'error'), true);
  await close(auth.lifecycle);
  await authStart;

  const aborted = makeLifecycle();
  await aborted.lifecycle.onStart(async () => { throw Object.assign(new Error('cancelled'), { name: 'AbortError' }); });
  assert.equal(aborted.lifecycle.startState, 'starting');
  await close(aborted.lifecycle);

  const late = makeLifecycle();
  let savedAttempt;
  await late.lifecycle.onStart(async (attempt) => { savedAttempt = attempt; });
  let cleaned = false;
  savedAttempt.onClose(() => { cleaned = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(cleaned, true);
  await close(late.lifecycle);
});

test('late startup success after close does not mark the node ready', async () => {
  const { lifecycle } = makeLifecycle(5);
  let finishStart;
  const start = lifecycle.onStart(() => new Promise((resolve) => { finishStart = resolve; }));
  await new Promise((resolve) => setImmediate(resolve));
  await close(lifecycle);
  finishStart();
  await start;
  assert.equal(lifecycle.startState, 'starting');
});

test('successful startup is terminal and does not auto-retry', async () => {
  const { lifecycle } = makeLifecycle();
  let attempts = 0;
  await lifecycle.onStart(async () => { attempts += 1; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(lifecycle.startState, 'ready');
  assert.equal(attempts, 1);
  await close(lifecycle);
});

test('unexpected retry timer errors reject startup and use the fallback close log key', async () => {
  const { lifecycle, logs } = makeLifecycle();
  const originalSetTimeout = global.setTimeout;
  global.setTimeout = () => { throw new Error('timer creation failed'); };
  let start;
  try {
    start = lifecycle.onStart(async () => { throw Object.assign(new Error('transient'), { code: 'ECONNRESET' }); }, {
      classify: () => 'transient'
    });
    await assert.rejects(start, /timer creation failed/);
  } finally {
    global.setTimeout = originalSetTimeout;
  }
  await close(lifecycle);
  assert.equal(logs.some(([, error, options]) => error.message === 'timer creation failed' && options.key === 'CLOSE_START_FAILED'), true);
});

test('external retry timer errors are rethrown after startup failure', async () => {
  const { lifecycle } = makeLifecycle();
  const originalSetTimeout = global.setTimeout;
  global.setTimeout = () => { throw new Error('retry timer failed'); };
  try {
    await assert.rejects(lifecycle.onStart(async () => { throw new Error('connect failed'); }), /retry timer failed/);
  } finally {
    global.setTimeout = originalSetTimeout;
  }
  await close(lifecycle);
});