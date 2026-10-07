'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createSecretStore } = require('../../lib/secrets');
const kit = require('../..');

function mockRED() {
  const logs = [];
  return {
    logs,
    value: {
      settings: {},
      log: Object.fromEntries(['error', 'warn', 'info', 'debug'].map((level) => [level, (message) => logs.push([level, message])]))
    }
  };
}

function mockNode(id, credentials = {}) {
  const node = new EventEmitter();
  node.id = id;
  node.credentials = credentials;
  node.status = () => {};
  node.logs = [];
  for (const level of ['error', 'warn', 'log', 'debug']) node[level] = (message) => node.logs.push([level, message]);
  return node;
}

function close(node) {
  return new Promise((resolve) => node.emit('close', false, resolve));
}

test('secret store masks all lengths, encoded values, sensitive fields, and cycles', () => {
  assert.throws(() => createSecretStore('password'), TypeError);
  const store = createSecretStore(['customField']);
  const release = store.acquire('p@ss');
  const cyclic = { password: 'visible', customField: 'visible', note: 'token=abc' };
  cyclic.self = cyclic;
  const safe = store.redactValue(cyclic);
  assert.equal(safe.password, '[REDACTED]');
  assert.equal(safe.customField, '[REDACTED]');
  assert.deepEqual(store.redactValue([{ token: 'visible' }]), [{ token: '[REDACTED]' }]);
  assert.equal(safe.note, 'token=[REDACTED]');
  assert.equal(safe.self, '[Circular]');
  assert.equal(store.redactText('value=p@ss encoded=p%40ss'), 'value=[REDACTED] encoded=[REDACTED]');
  release();
  assert.equal(store.redactText('p@ss'), 'p@ss');
});

test('secret store ignores invalid leases and does not invoke object getters', () => {
  const store = createSecretStore();
  const release = store.acquire('');
  release();
  assert.equal(store.size, 0);
  assert.equal(store.redactValue(null), null);
  assert.equal(store.redactValue(42), 42);
  let getterCalled = false;
  const input = Object.defineProperty({}, 'computed', {
    enumerable: true,
    get() { getterCalled = true; throw new Error('getter must not run'); }
  });
  const output = store.redactValue(input);
  assert.equal(getterCalled, false);
  assert.deepEqual(output, {});

  const error = new Error('safe');
  error.code = 42;
  Object.defineProperty(error, 'stack', { value: undefined, configurable: true });
  const safeError = store.redactValue(error);
  assert.equal(Object.hasOwn(safeError, 'code'), false);
  assert.equal(typeof safeError.stack, 'string');
});

test('Error message, stack, and cause are redacted without mutating the original', () => {
  const store = createSecretStore();
  const release = store.acquire('private-value');
  const cause = new Error('cause private-value');
  const error = new Error('outer private-value', { cause });
  error.stack = 'Error: private-value\n at private-value';
  const safe = store.redactValue(error);
  assert.equal(safe.message.includes('private-value'), false);
  assert.equal(safe.stack.includes('private-value'), false);
  assert.equal(safe.cause.message.includes('private-value'), false);
  assert.equal(error.message.includes('private-value'), true);
  release();
});

test('two nodes hold duplicate secret leases independently', async () => {
  const mock = mockRED();
  const rk = kit.init(mock.value, { domain: 'redis' });
  const first = mockNode('first');
  const second = mockNode('second');
  const firstContext = rk.bind(first);
  const secondContext = rk.bind(second);
  firstContext.secret('shared-pass');
  secondContext.secret('shared-pass');
  firstContext.log.error('redis rejected shared-pass');
  assert.equal(first.logs.at(-1)[1].includes('[REDACTED]'), true);
  await close(first);
  secondContext.log.error('redis rejected shared-pass');
  assert.equal(second.logs.at(-1)[1].includes('[REDACTED]'), true);
  await close(second);
  assert.equal(rk.bind(mockNode('third')).log !== undefined, true);
});

test('independent init contexts do not share secret owners or redaction closures', async () => {
  const firstMock = mockRED();
  const secondMock = mockRED();
  const firstNode = mockNode('first-context');
  const secondNode = mockNode('second-context');
  const first = kit.init(firstMock.value, { domain: 'redis' }).bind(firstNode);
  const second = kit.init(secondMock.value, { domain: 'redis' }).bind(secondNode);
  first.secret('first-context-secret');
  second.secret('second-context-secret');

  first.log.error('first-context-secret second-context-secret');
  second.log.error('first-context-secret second-context-secret');
  assert.equal(firstNode.logs.at(-1)[1].includes('first-context-secret'), false);
  assert.equal(firstNode.logs.at(-1)[1].includes('second-context-secret'), true);
  assert.equal(secondNode.logs.at(-1)[1].includes('second-context-secret'), false);
  assert.equal(secondNode.logs.at(-1)[1].includes('first-context-secret'), true);
  await close(firstNode);
  await close(secondNode);
});

test('credential rotation and duplicate close release each owner lease exactly once', async () => {
  const mock = mockRED();
  const rk = kit.init(mock.value, { domain: 'redis' });
  const rotating = mockNode('rotating', { password: 'shared-password' });
  const stable = mockNode('stable', { password: 'shared-password' });
  const rotatingContext = rk.bind(rotating);
  const stableContext = rk.bind(stable);
  rotatingContext.readSecret('password');
  stableContext.readSecret('password');
  assert.equal(stableContext.readSecret('password'), 'shared-password');
  rotating.credentials.password = 'new-password';
  rotatingContext.readSecret('password');
  await close(rotating);
  await close(rotating);
  stableContext.log.error('redis error: shared-password');
  assert.equal(stable.logs.at(-1)[1].includes('shared-password'), false);
  delete stable.credentials.password;
  assert.equal(stableContext.readSecret('password'), undefined);
  stableContext.log.error('redis error: shared-password');
  assert.equal(stable.logs.at(-1)[1].includes('shared-password'), true);
  await close(stable);
});

test('secret leases are idempotent and credential read registers the value', async () => {
  const store = createSecretStore();
  const release = store.acquire('lease-value');
  release();
  release();
  assert.equal(store.size, 0);
  const mock = mockRED();
  const rk = kit.init(mock.value, { domain: 'redis' });
  const node = mockNode('credential', { password: 'credential-value' });
  const context = rk.bind(node);
  assert.equal(context.readSecret('password'), 'credential-value');
  context.log.error('failed credential-value');
  assert.equal(node.logs.at(-1)[1].includes('credential-value'), false);
  assert.throws(() => context.readSecret(''), /field is required/);
  await close(node);
});

test('readSecret honors explicit credential clearing and legacy fallback only when absent', async () => {
  const mock = mockRED();
  const rk = kit.init(mock.value, { domain: 'redis' });
  const legacy = mockNode('legacy', {});
  const legacyContext = rk.bind(legacy);
  assert.equal(legacyContext.readSecret('password', { legacyConfig: { password: 'old' } }), 'old');
  legacyContext.readSecret('password', { legacyConfig: { password: 'old' } });
  assert.equal(legacy.logs.filter(([level]) => level === 'warn').length, 1);
  await close(legacy);

  const cleared = mockNode('cleared', { password: '' });
  const clearedContext = rk.bind(cleared);
  assert.equal(clearedContext.readSecret('password', { legacyConfig: { password: 'old' } }), undefined);
  await close(cleared);

  const rotated = mockNode('rotated-clear', { password: 'registered-value' });
  const rotatedContext = rk.bind(rotated);
  assert.equal(rotatedContext.readSecret('password'), 'registered-value');
  rotated.credentials.password = '';
  assert.equal(rotatedContext.readSecret('password'), undefined);
  rotatedContext.log.error('credential registered-value cleared');
  assert.equal(rotated.logs.at(-1)[1].includes('registered-value'), true);
  await close(rotated);
});

test('node secret helpers validate labels, values, and non-string credentials', async () => {
  const mock = mockRED();
  const node = mockNode('invalid-secret', { password: 12 });
  const context = kit.init(mock.value, { domain: 'redis' }).bind(node);
  assert.equal(context.readSecret('password'), undefined);
  assert.throws(() => context.secret(''), /non-empty string/);
  assert.throws(() => context.requireSecret('', ''), /label is required/);
  assert.equal(context.requireSecret('', 'password'), false);
  assert.equal(context.requireSecret('available', 'password'), true);
  const release = context.secret('temporary-secret');
  release();
  release();
  await close(node);
});

test('legacy secret handling accepts only non-empty strings and validates top-level context', async () => {
  const mock = mockRED();
  const node = mockNode('legacy-values');
  const context = kit.init(mock.value, { domain: 'redis' }).bind(node);
  assert.equal(context.readSecret('password', { legacyConfig: { password: 12 } }), undefined);
  assert.equal(node.logs.filter(([level]) => level === 'warn').length, 1);
  await close(node);
  assert.throws(() => kit.requireSecret(null, 'value', 'label'), /node context/);
});

test('secret lookup tolerates missing credentials and releases a registered value when cleared', async () => {
  const mock = mockRED();
  const node = mockNode('missing-credentials');
  node.credentials = undefined;
  const context = kit.init(mock.value, { domain: 'redis' }).bind(node);
  assert.equal(context.readSecret('token'), undefined);
  node.credentials = { token: 'registered-token' };
  assert.equal(context.readSecret('token'), 'registered-token');
  node.credentials = {};
  assert.equal(context.readSecret('token'), undefined);
  context.log.error('token value registered-token');
  assert.equal(node.logs.at(-1)[1].includes('registered-token'), true);
  await close(node);
});

test('requireSecret blocks startup before handler I/O', async () => {
  const mock = mockRED();
  const rk = kit.init(mock.value, { domain: 'redis' });
  const node = mockNode('required');
  const context = rk.bind(node);
  assert.equal(context.requireSecret('', 'password'), false);
  let started = false;
  await context.onStart(async () => { started = true; });
  assert.equal(started, false);
  assert.equal(context.status !== undefined, true);
  await close(node);
});

test('status and logs redact secret values and track rejects work after close', async () => {
  const mock = mockRED();
  const rk = kit.init(mock.value, { domain: 'redis' });
  const statuses = [];
  const node = mockNode('redacted-status');
  node.status = (value) => statuses.push(value);
  const context = rk.bind(node);
  context.secret('status-secret');
  context.status('error', 'failed status-secret');
  assert.equal(statuses.at(-1).text.includes('status-secret'), false);
  await close(node);
  const logCountAfterClose = node.logs.length;
  assert.equal(await context.track(Promise.reject(new Error('late status-secret rejection'))), false);
  assert.equal(node.logs.length, logCountAfterClose);
});

test('top-level requireSecret delegates to bound node context', () => {
  const mock = mockRED();
  const rk = kit.init(mock.value, { domain: 'redis' });
  const context = rk.bind(mockNode('helper'));
  assert.equal(kit.requireSecret(context, 'present', 'password'), true);
  assert.equal(kit.requireSecret(context, '', 'password'), false);
});