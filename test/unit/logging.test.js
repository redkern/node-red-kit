'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createLogger, createStatus, STATES } = require('../../lib/logging');

test('shared Node-RED status definitions are immutable', () => {
  assert.equal(Object.isFrozen(STATES), true);
  assert.ok(Object.values(STATES).every(Object.isFrozen));
  assert.throws(() => { STATES.ok[0] = 'red'; }, TypeError);
  assert.throws(() => { STATES.new = ['purple', 'dot']; }, TypeError);
});

test('status uses Node-RED colors and keeps text below 20 characters', () => {
  const updates = [];
  const status = createStatus({ status: (value) => updates.push(value) }, { minIntervalMs: 0 });
  status('error', 'a status message that is much too long');
  status('ok', 'ready');
  status('paused', 'paused');
  status.dispose();
  assert.deepEqual(updates.map(({ fill, shape }) => [fill, shape]), [
    ['red', 'ring'],
    ['green', 'dot'],
    ['blue', 'ring']
  ]);
  assert.ok(updates.every(({ text }) => text.length < 20));
});

test('disabled status uses Node-RED dot shape', () => {
  const updates = [];
  const status = createStatus({ status: (value) => updates.push(value) }, { minIntervalMs: 0 });
  status('disabled', 'disabled');
  assert.deepEqual([updates[0].fill, updates[0].shape], ['grey', 'dot']);
  status.dispose();
});

test('system status overlays restore the latest palette status when cleared', () => {
  const updates = [];
  const status = createStatus({ status: (value) => updates.push(value) }, { minIntervalMs: 0 });
  status('starting', 'connecting');
  status.setOverlay('internal-server', 'error', 'listener failed');
  status('ok', 'connected');
  assert.equal(updates.at(-1).text, 'listener failed');
  status.clearOverlay('internal-server');
  assert.deepEqual(updates.at(-1), { fill: 'green', shape: 'dot', text: 'connected' });
  status.setOverlay('internal-server', 'warn', 'temporary warning');
  status.dispose();

  const noBaseUpdates = [];
  const noBase = createStatus({ status: (value) => noBaseUpdates.push(value) }, { minIntervalMs: 0 });
  noBase.setOverlay('internal-server', 'error', 'listener failed');
  noBase.clearOverlay('internal-server');
  assert.deepEqual(noBaseUpdates.at(-1), {});
  noBase.dispose();
});

test('status overlays validate keys/states, respect priority, and ignore calls after disposal', () => {
  const updates = [];
  const status = createStatus({ status: (value) => updates.push(value) }, { minIntervalMs: 0 });
  assert.throws(() => status.setOverlay('', 'error', 'invalid'), /overlay key/);
  assert.throws(() => status.setOverlay('invalid-state', 'unknown', 'invalid'), /Unknown status/);
  status.setOverlay('high', 'error', 'higher priority');
  status.setOverlay('low', 'warn', 'lower priority');
  assert.equal(updates.at(-1).text, 'higher priority');
  status.clearOverlay('missing');
  status.dispose();
  status.setOverlay('after-dispose', 'error', 'ignored');
  status.clearOverlay('high');
  assert.equal(updates.at(-1).text, 'higher priority');
});

test('node logs use Node-RED node methods and dedupe emits a trailing summary', async () => {
  const records = [];
  const node = Object.fromEntries(['error', 'warn', 'log', 'debug'].map((level) => [level, (message) => records.push([level, message])]));
  const logger = createLogger({
    RED: { log: {} },
    node,
    prefix: '[redkern:redis]',
    id: 'n1',
    redact: (value) => String(value).replaceAll('secret', '[REDACTED]'),
    intervalMs: 10
  });
  logger.info('secret connected', { key: 'CONNECTION' });
  logger.info('secret connected', { key: 'CONNECTION' });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(records[0][0], 'log');
  assert.equal(records[0][1].includes('[REDACTED]'), true);
  assert.equal(records[1][1].includes('suppressed 1'), true);
  logger.dispose();
});

test('plugin logger falls back to RED.log, redacts Error, and LRU eviction summarizes', () => {
  const records = [];
  const logger = createLogger({
    RED: { log: Object.fromEntries(['error', 'warn', 'info', 'debug'].map((level) => [level, (message) => records.push([level, message])])) },
    prefix: '[redkern:plugin]',
    id: 'p1',
    maxKeys: 1,
    redact: (value) => String(value).replaceAll('password-value', '[REDACTED]')
  });
  const error = Object.assign(new Error('password-value failed'), { code: 'CONNECT' });
  logger.error(error);
  logger.error(error);
  logger.warn('warning one', { key: 'WARN_ONE' });
  assert.equal(records[0][0], 'error');
  assert.equal(records[0][1].includes('[REDACTED]'), true);
  assert.equal(records.some(([, message]) => message.includes('suppressed 1')), true);
  logger.dispose();
});

test('logger disposal flushes pending summaries and ignores future writes', () => {
  const records = [];
  const logger = createLogger({
    RED: { log: Object.fromEntries(['error', 'warn', 'info', 'debug'].map((level) => [level, (message) => records.push([level, message])])) },
    prefix: '[redkern:plugin]',
    id: 'p2',
    intervalMs: 10000
  });
  logger.warn('first', { key: 'WARN' });
  logger.warn('again', { key: 'WARN' });
  logger.dispose();
  logger.error('after dispose');
  assert.equal(records.length, 2);
  assert.equal(records[1][1].includes('suppressed 1'), true);
});

test('logger handles cyclic redacted values and unavailable output methods', () => {
  const records = [];
  const cyclic = {};
  cyclic.self = cyclic;
  const logger = createLogger({
    RED: { log: { info: (message) => records.push(message) } },
    prefix: '[redkern:test]',
    redact: (value) => value
  });
  logger.info(cyclic);
  logger.error('not emitted');
  logger.dispose();
  assert.match(records[0], /Unserializable log value/);

  const nodeLogger = createLogger({ RED: {}, node: {}, prefix: '[redkern:test]' });
  nodeLogger.debug('not emitted');
  nodeLogger.dispose();
});

test('logger includes correlation IDs and derives dedupe keys from Error codes', () => {
  const records = [];
  const logger = createLogger({
    RED: { log: Object.fromEntries(['error', 'warn', 'info', 'debug'].map((level) => [level, (message) => records.push([level, message])])) },
    prefix: '[redkern:plugin]',
    intervalMs: 10000
  });
  logger.info('connected', { correlationId: 'trace-1' });
  const error = Object.assign(new Error('temporary'), { code: 'TEMPORARY' });
  logger.error(error);
  logger.error(error);
  assert.equal(records[0][1].includes('[trace-1]'), true);
  assert.equal(records.filter(([, message]) => message.includes('temporary')).length, 1);
  logger.dispose();
  assert.equal(records.at(-1)[1].includes('suppressed 1'), true);
});

test('logger renders redacted Error objects and expires a pending dedupe window', () => {
  const records = [];
  const logger = createLogger({
    RED: { log: Object.fromEntries(['error', 'warn', 'info', 'debug'].map((level) => [level, (message) => records.push([level, message])])) },
    prefix: '[redkern:test]',
    intervalMs: 10000,
    redact: (value) => value
  });
  logger.error(Object.assign(new Error('safe failure'), { code: 'SAFE_FAILURE' }));
  assert.match(records[0][1], /Error: safe failure/);

  const originalNow = Date.now;
  let now = 1000;
  Date.now = () => now;
  try {
    logger.warn('first', { key: 'ROTATE' });
    logger.warn('suppressed', { key: 'ROTATE' });
    now += 20000;
    logger.warn('after window', { key: 'ROTATE' });
  } finally {
    Date.now = originalNow;
  }
  assert.equal(records.some(([, message]) => message.includes('suppressed 1')), true);
  assert.equal(records.at(-1)[1].includes('after window'), true);
  logger.dispose();
});

test('status rate limit applies the last state and dispose cancels trailing update', async () => {
  const updates = [];
  const status = createStatus({ status: (value) => updates.push(value) }, { minIntervalMs: 15 });
  status('starting', 'starting');
  status('error', 'redacted');
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(updates.at(-1).fill, 'red');
  assert.throws(() => status('unknown', 'invalid'), /Unknown status/);
  status('warn', 'pending');
  status.dispose();
  status('ok', 'after dispose');
  const count = updates.length;
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(updates.length, count);
  const immediate = createStatus({ status: (value) => updates.push(value) }, { minIntervalMs: 0 });
  immediate('idle', '');
  assert.equal(updates.at(-1).text, 'idle');
  immediate.dispose();
});

test('status applies an update immediately after cadence expires and clears its timer', () => {
  const originalNow = Date.now;
  let now = 100;
  let timerCallback;
  const cleared = [];
  const updates = [];
  const status = createStatus({ status: (value) => updates.push(value) }, {
    minIntervalMs: 10,
    onTimer(callback) { timerCallback = callback; return 'pending-timer'; },
    clearTimer(timer) { cleared.push(timer); }
  });
  try {
    Date.now = () => now;
    status('ok', 'ready');
    status('warn', 'queued');
    now += 20;
    status('error', 'immediate');
    assert.deepEqual(updates.map((update) => update.fill), ['green', 'red']);
    assert.deepEqual(cleared, ['pending-timer']);
    timerCallback();
    assert.equal(updates.length, 2);
  } finally {
    Date.now = originalNow;
    status.dispose();
  }
});

test('status cadence timer is unrefed and cleared on disposal', () => {
  let unrefCalls = 0;
  let timerCallback;
  let cleared;
  const handle = { unref() { unrefCalls += 1; } };
  const status = createStatus({ status() {} }, {
    minIntervalMs: 1000,
    onTimer(callback) { timerCallback = callback; return handle; },
    clearTimer(value) { cleared = value; }
  });
  status('ok', 'ready');
  status('warn', 'queued');
  assert.equal(typeof timerCallback, 'function');
  assert.equal(unrefCalls, 1);
  status.dispose();
  assert.equal(cleared, handle);
});

test('a trailing status timer cannot apply after disposal', () => {
  const updates = [];
  let trailing;
  const status = createStatus({ status: (value) => updates.push(value) }, {
    minIntervalMs: 100,
    onTimer(callback) { trailing = callback; return 'trailing'; },
    clearTimer() {}
  });
  status('ok', 'ready');
  status('warn', 'queued');
  status.dispose();
  trailing();
  assert.equal(updates.length, 1);
});