'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { backoff, sleep, retry, withTimeout, createLimiter, classifyError } = require('../../lib/resilience');

test('backoff supports bounds, reset, and invalid options', () => {
  const delays = backoff({ initial: 10, max: 20, multiplier: 2, jitter: 0 });
  assert.equal(delays.next(), 10);
  assert.equal(delays.next(), 20);
  delays.reset();
  assert.equal(delays.next(), 10);
  assert.throws(() => backoff({ initial: 2, max: 1 }), TypeError);
  assert.throws(() => backoff({ initial: 1, max: 2, jitter: 'bad' }).next(), TypeError);
  assert.throws(() => backoff({ initial: Infinity, max: 10 }), TypeError);
  assert.throws(() => backoff({ initial: 1, max: 2, jitter: 2 }), TypeError);
});

test('backoff equal and fractional jitter stay within specified bounds', () => {
  const originalRandom = Math.random;
  try {
    Math.random = () => 0;
    assert.equal(backoff({ initial: 100, max: 200, jitter: 'equal' }).next(), 50);
    assert.equal(backoff({ initial: 100, max: 200, jitter: 0.5 }).next(), 50);
    Math.random = () => 0.999;
    assert.equal(backoff({ initial: 100, max: 100, jitter: 1 }).next(), 100);
  } finally { Math.random = originalRandom; }
});

test('sleep and retry respect AbortSignal', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(sleep(1, controller.signal), { name: 'AbortError' });
  await assert.rejects(retry(async () => 1, { attempts: 2, backoff: backoff({ initial: 1, max: 1 }), signal: controller.signal }), { name: 'AbortError' });
  await assert.rejects(sleep(Number.NaN), TypeError);
});

test('retry retries only matching errors', async () => {
  let attempts = 0;
  const value = await retry(async () => {
    attempts += 1;
    if (attempts < 2) throw Object.assign(new Error('temporary'), { code: 'TEMP' });
    return 'ok';
  }, { attempts: 3, backoff: backoff({ initial: 0, max: 0 }), retryOn: (error) => error.code === 'TEMP' });
  assert.equal(value, 'ok');
  assert.equal(attempts, 2);
  await assert.rejects(retry(async () => { throw new Error('no'); }, { attempts: 3, backoff: backoff({ initial: 0, max: 0 }) }), /no/);
  await assert.rejects(retry(() => 1, { attempts: Number.MAX_SAFE_INTEGER + 1, backoff: backoff({ initial: 0, max: 0 }) }), TypeError);
  await assert.rejects(retry(() => { throw new Error('original'); }, {
    attempts: 2,
    backoff: backoff({ initial: 0, max: 0 }),
    retryOn: () => { throw new Error('classifier failed'); }
  }), /classifier failed/);
});

test('withTimeout clears on success and handles late rejection', async () => {
  assert.equal(await withTimeout(Promise.resolve('ok'), 100), 'ok');
  const signal = new AbortController();
  assert.equal(await withTimeout(Promise.resolve('signal-ok'), 100, { signal: signal.signal }), 'signal-ok');
  await assert.rejects(withTimeout(new Promise((_, reject) => setTimeout(() => reject(new Error('late')), 20)), 1), { code: 'OPERATION_TIMEOUT' });
  await assert.rejects(withTimeout(new Promise(() => {}), 100, { signal: AbortSignal.abort() }), { name: 'AbortError' });
  assert.throws(() => withTimeout(Promise.resolve(), Infinity), TypeError);
});

test('limiter enforces concurrency and queue bounds', async () => {
  const limiter = createLimiter({ concurrency: 1, maxQueue: 1 });
  let release;
  const first = limiter.run(() => new Promise((resolve) => { release = resolve; }));
  const second = limiter.run(() => 'second');
  assert.equal(limiter.pending, 1);
  await assert.rejects(limiter.run(() => 'overflow'), { code: 'LIMITER_QUEUE_FULL' });
  release('first');
  assert.equal(await first, 'first');
  assert.equal(await second, 'second');
  assert.throws(() => createLimiter({ concurrency: 0 }), TypeError);
});

test('limiter rejects queued work when its signal aborts', async () => {
  const limiter = createLimiter({ concurrency: 1, maxQueue: 1 });
  let release;
  const first = limiter.run(() => new Promise((resolve) => { release = resolve; }));
  const controller = new AbortController();
  const queued = limiter.run(() => 'never', { signal: controller.signal });
  controller.abort();
  await assert.rejects(queued, { name: 'AbortError' });
  release();
  await first;
});

test('limiter exposes stats, closes queued work, and rejects future work', async () => {
  const limiter = createLimiter({ concurrency: 1, maxQueue: 1 });
  let release;
  const first = limiter.run(() => new Promise((resolve) => { release = resolve; }));
  const queuedSignal = new AbortController();
  const queued = limiter.run(() => 'queued', { signal: queuedSignal.signal });
  assert.deepEqual(limiter.stats(), { active: 1, queued: 1, closed: false });
  limiter.close();
  await assert.rejects(queued, { name: 'AbortError' });
  await assert.rejects(limiter.run(() => 'closed'), { name: 'AbortError' });
  release('active');
  assert.equal(await first, 'active');
  assert.deepEqual(limiter.stats(), { active: 0, queued: 0, closed: true });
});

test('limiter releases its slot and drains queued work after task rejection', async () => {
  const limiter = createLimiter({ concurrency: 1, maxQueue: 1 });
  const failed = limiter.run(() => { throw new Error('task failed'); });
  const queued = limiter.run(() => 'continued');
  await assert.rejects(failed, /task failed/);
  assert.equal(await queued, 'continued');
  assert.deepEqual(limiter.stats(), { active: 0, queued: 0, closed: false });
  limiter.close();
});

test('classifyError separates config, abort, network, TLS, and unknown failures', () => {
  assert.equal(classifyError({ code: 'CONFIG_INVALID' }), 'config');
  assert.equal(classifyError({ code: 'ABORT_ERR' }), 'abort');
  assert.equal(classifyError({ code: 'ECONNRESET' }), 'transient');
  assert.equal(classifyError({ code: 'ERR_TLS_CERT_ALTNAME_INVALID' }), 'auth');
  assert.equal(classifyError(new Error('unknown')), 'transient');
});

test('resilience APIs reject invalid boundaries and handle active aborts', async () => {
  assert.throws(() => backoff({ initial: -1, max: 1 }), TypeError);
  assert.throws(() => backoff({ initial: 1, max: 2, multiplier: 0.5 }), TypeError);
  assert.throws(() => backoff({ initial: 1, max: 2147483648 }), TypeError);
  assert.throws(() => backoff({ initial: 1, max: 2, jitter: Number.NaN }), TypeError);

  await assert.rejects(sleep(-1), TypeError);
  await assert.rejects(sleep(2147483648), TypeError);
  const sleeper = new AbortController();
  const waiting = sleep(1000, sleeper.signal);
  sleeper.abort();
  await assert.rejects(waiting, { name: 'AbortError', code: 'ABORT_ERR' });

  const delay = backoff({ initial: 0, max: 0 });
  await assert.rejects(retry(null, { attempts: 1, backoff: delay }), TypeError);
  await assert.rejects(retry(() => 1, { attempts: 1, backoff: {}, retryOn() {} }), TypeError);
  await assert.rejects(retry(() => 1, { attempts: 1, backoff: delay, retryOn: null }), TypeError);
  await assert.rejects(retry(async () => { throw Object.assign(new Error('aborted'), { name: 'AbortError' }); }, {
    attempts: 2,
    backoff: delay,
    retryOn: () => true
  }), { name: 'AbortError' });

  await assert.rejects(withTimeout(new Promise(() => {}), 1000, { signal: AbortSignal.abort() }), { name: 'AbortError' });
  assert.throws(() => withTimeout(Promise.resolve(), -1), TypeError);

  const limiter = createLimiter({ concurrency: 1, maxQueue: 0 });
  assert.equal(limiter.pending, 0);
  await assert.rejects(limiter.run(null), TypeError);
  assert.throws(() => createLimiter({ concurrency: 1, maxQueue: -1 }), TypeError);
  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(limiter.run(() => {}, { signal: aborted.signal }), { name: 'AbortError' });
  let releaseTask;
  const activeTask = limiter.run(() => new Promise((resolve) => { releaseTask = resolve; }));
  await assert.rejects(limiter.run(() => {}), { code: 'LIMITER_QUEUE_FULL' });
  releaseTask();
  await activeTask;
  limiter.close();
  assert.deepEqual(limiter.stats(), { active: 0, queued: 0, closed: true });

  assert.equal(classifyError({ code: 42 }), 'transient');
  assert.equal(classifyError({ code: 'SELF_SIGNED_CERT_IN_CHAIN' }), 'auth');
});