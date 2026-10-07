'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const { names, instanceId } = require('../../lib/naming');

test('names builds the complete domain namespace', () => {
  assert.deepEqual(names('redis'), {
    typePrefix: 'redkern-redis-',
    category: 'redkern redis',
    routeBase: '/redkern/redis',
    permRead: 'redkern.redis.read',
    permWrite: 'redkern.redis.write',
    permData: 'redkern.redis.data',
    envPrefix: 'REDKERN_REDIS_',
    logPrefix: '[redkern:redis]',
    cssPrefix: 'redkern-redis-'
  });
  assert.equal(Object.isFrozen(names('redis')), true);
});

test('names accepts any valid domain without a registry', () => {
  assert.equal(names('newdomain').routeBase, '/redkern/newdomain');
});

test('names rejects domains outside the specified format', () => {
  for (const domain of ['a', 'Aredis', 'red-is', 'red1', 'abcdefghijklmnopq', '', null]) {
    assert.throws(() => names(domain), TypeError);
  }
});

test('instanceId uses the operating system hostname and ignores HOSTNAME', () => {
  const previous = process.env.HOSTNAME;
  process.env.HOSTNAME = 'spoofed-hostname';
  try {
    assert.equal(instanceId(), os.hostname());
  } finally {
    if (previous === undefined) delete process.env.HOSTNAME;
    else process.env.HOSTNAME = previous;
  }
});

test('declared Redis subpath resolves and deep imports stay closed', () => {
  const redis = require('@redkern/node-red-kit/redis');
  for (const name of ['createRedisClient', 'classifyRedisError', 'defineScripts', 'hashTag']) {
    assert.equal(typeof redis[name], 'function');
  }
  assert.throws(() => redis.createRedisClient(), /Redis options are required/);
  assert.equal(redis.hashTag('stream', 'group'), 'stream:{group}');
  assert.throws(() => require('@redkern/node-red-kit/lib/http.js'), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' });
});