'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const Redis = require('ioredis');
const { createRedisClient, classifyRedisError, defineScripts, hashTag } = require('../..').redis || require('../../redis');

class FakeRedis extends EventEmitter {
  constructor(options) {
    super();
    this.options = options;
    this.status = 'wait';
    this.connectCount = 0;
    this.commands = {};
  }
  async connect() { this.connectCount += 1; this.status = 'ready'; }
  async quit() { this.status = 'end'; this.emit('end'); return 'OK'; }
  disconnect() { this.status = 'end'; this.emit('end'); }
  defineCommand(name, definition) { this.commands[name] = definition; }
}

class FakeCluster extends FakeRedis {
  constructor(nodes, options) {
    super(options);
    this.nodes = nodes;
    this.startupNodes = nodes;
  }
}

FakeRedis.Cluster = FakeCluster;

function baseOptions(overrides = {}) {
  return {
    ioredis: FakeRedis,
    domain: 'redis',
    configId: '12345678-rest',
    role: 'shared',
    mode: 'standalone',
    host: 'redis.internal',
    port: 6379,
    logger: { error() {} },
    ...overrides
  };
}

test('shared Redis handle is lazy, disables unsafe queues, and connects once', async () => {
  const handle = createRedisClient(baseOptions());
  assert.equal(handle.client.connectCount, 0);
  assert.equal(handle.client.options.lazyConnect, true);
  assert.equal(handle.client.options.enableOfflineQueue, false);
  assert.equal(handle.client.options.autoResendUnfulfilledCommands, false);
  assert.equal(handle.client.options.enableAutoPipelining, true);
  assert.equal(handle.client.options.maxRetriesPerRequest, 3);
  assert.equal(handle.client.options.commandTimeout, 5000);
  assert.equal(handle.client.options.retryStrategy(40), 30000);
  const [first, second] = await Promise.all([handle.connect(), handle.connect()]);
  assert.equal(first, undefined);
  assert.equal(second, undefined);
  assert.equal(handle.client.connectCount, 1);
  await handle.connect();
  assert.equal(handle.client.connectCount, 1);
  await handle.close();
  assert.equal(handle.client.status, 'end');
  await handle.close();
});

test('shared Redis accepts an explicit command timeout', () => {
  const handle = createRedisClient(baseOptions({ commandTimeout: 2500 }));
  assert.equal(handle.client.options.commandTimeout, 2500);
});

test("cluster connect waits for the client's automatic startup instead of connecting twice", async () => {
  class AutoStartingCluster extends FakeCluster {
    constructor(nodes, options) {
      super(nodes, options);
      this.status = 'connecting';
      setImmediate(() => { this.status = 'ready'; this.emit('ready'); });
    }
    async connect() { throw new Error('Redis is already connecting/connected'); }
    async cluster(command) { return command === 'INFO' ? 'cluster_state:ok\r\n' : 'OK'; }
  }
  class ClusterRedis extends FakeRedis {}
  ClusterRedis.Cluster = AutoStartingCluster;
  const handle = createRedisClient(baseOptions({
    ioredis: ClusterRedis,
    mode: 'cluster',
    nodes: [{ host: 'redis-1.internal', port: 6379 }]
  }));
  await Promise.all([handle.connect(), handle.connect()]);
  assert.equal(handle.client.status, 'ready');
  assert.equal(handle.client.connectCount, 0);
  await handle.connect();
  handle.force();
});

test('Redis readiness reports an ended or timed-out in-progress connection', async () => {
  class EndingRedis extends FakeRedis {
    constructor(options) {
      super(options);
      this.status = 'connecting';
      setImmediate(() => { this.status = 'end'; this.emit('end'); });
    }
  }
  EndingRedis.Cluster = FakeCluster;
  const ending = createRedisClient(baseOptions({ ioredis: EndingRedis, connectTimeout: 50 }));
  await assert.rejects(ending.connect(), { code: 'REDIS_CONNECT_CLOSED' });
  await ending.close();

  class AlreadyEndedRedis extends FakeRedis {
    constructor(options) {
      super(options);
      this.statusReads = 0;
    }
    get status() { return ++this.statusReads < 4 ? 'connecting' : 'end'; }
    set status(value) { this._status = value; }
  }
  AlreadyEndedRedis.Cluster = FakeCluster;
  const alreadyEnded = createRedisClient(baseOptions({ ioredis: AlreadyEndedRedis }));
  await assert.rejects(alreadyEnded.connect(), { code: 'REDIS_CONNECT_CLOSED' });
  await alreadyEnded.close();

  class StuckRedis extends FakeRedis {
    constructor(options) { super(options); this.status = 'connecting'; }
  }
  StuckRedis.Cluster = FakeCluster;
  const stuck = createRedisClient(baseOptions({ ioredis: StuckRedis, connectTimeout: 10 }));
  await assert.rejects(stuck.connect(), { code: 'REDIS_CONNECT_TIMEOUT' });
  stuck.force();
});

test('Redis ready-event race resolves without missing the ready callback', async () => {
  class RacingRedis extends FakeRedis {
    constructor(options) {
      super(options);
      this.statusReads = 0;
    }
    get status() { return ++this.statusReads === 1 ? 'connecting' : 'ready'; }
    set status(value) { this._status = value; }
    async connect() { throw new Error('connect must not run after ready'); }
  }
  RacingRedis.Cluster = FakeCluster;
  const handle = createRedisClient(baseOptions({ ioredis: RacingRedis }));
  await handle.connect();
  handle.force();
});

test('Redis Cluster rejects a connected but not-ready cluster state', async () => {
  class NotReadyCluster extends FakeCluster {
    constructor(nodes, options) { super(nodes, options); this.status = 'ready'; }
    async cluster() { return 'cluster_state:fail\r\n'; }
  }
  class NotReadyRedis extends FakeRedis {}
  NotReadyRedis.Cluster = NotReadyCluster;
  const handle = createRedisClient(baseOptions({
    ioredis: NotReadyRedis,
    mode: 'cluster',
    nodes: [{ host: 'redis-1.internal', port: 6379 }]
  }));
  await assert.rejects(handle.connect(), { code: 'REDIS_CLUSTER_NOT_READY' });
  handle.force();
});

test('Redis connect restarts an ended client that has not been closed by the handle', async () => {
  const handle = createRedisClient(baseOptions());
  handle.client.disconnect();
  await handle.connect();
  assert.equal(handle.client.status, 'ready');
  assert.equal(handle.client.connectCount, 1);
  await handle.close();
});

test('blocking/subscriber roles disable replay and validate command timeout', () => {
  const blocking = createRedisClient(baseOptions({ role: 'blocking', commandTimeout: 2000, blockMs: 1000 }));
  assert.equal(blocking.client.options.enableAutoPipelining, false);
  assert.equal(blocking.client.options.maxRetriesPerRequest, null);
  assert.equal(blocking.client.options.autoResendUnfulfilledCommands, false);
  assert.equal(blocking.client.options.commandTimeout, 2000);
  assert.throws(() => createRedisClient(baseOptions({ role: 'blocking', commandTimeout: 1000, blockMs: 1000 })), /exceed BLOCK/);
  const subscriber = createRedisClient(baseOptions({ role: 'subscriber' }));
  assert.equal(subscriber.client.options.autoResubscribe, true);
  assert.equal(subscriber.client.options.enableAutoPipelining, false);
});

test('cluster requires db zero and applies TLS hostname-safe options', () => {
  const nodes = [{ host: 'redis-1.internal', port: 6379 }];
  assert.throws(() => createRedisClient(baseOptions({ mode: 'cluster', nodes, db: 1 })), /database 0/);
  const handle = createRedisClient(baseOptions({ mode: 'cluster', nodes, tls: { rejectUnauthorized: true } }));
  assert.deepEqual(handle.client.startupNodes, [{ ...nodes[0], tls: { rejectUnauthorized: true, servername: 'redis-1.internal' } }]);
  assert.equal(handle.client.options.redisOptions.lazyConnect, true);
  assert.equal(handle.client.options.redisOptions.connectionName.startsWith('redkern-redis-shared-12345678-'), true);
  assert.deepEqual(handle.client.options.redisOptions.tls, { rejectUnauthorized: true });
  assert.equal(handle.client.options.redisOptions.dnsLookup, undefined);
  assert.throws(() => createRedisClient(baseOptions({ mode: 'cluster', nodes, tls: { rejectUnauthorized: false } })), /certificate verification/);

  const natMap = { 'redis-1.internal:6379': { host: 'redis-1.internal', port: 6379 } };
  const mapped = createRedisClient(baseOptions({ mode: 'cluster', nodes, natMap }));
  assert.equal(mapped.client.options.lazyConnect, true);
  assert.equal(mapped.client.options.enableOfflineQueue, false);
  assert.equal(mapped.client.options.enableReadyCheck, false);
  assert.equal(mapped.client.options.redisOptions.enableOfflineQueue, true);
  assert.equal(mapped.client.options.slotsRefreshTimeout, 10000);
  assert.deepEqual(mapped.client.options.natMap, natMap);
  const realCluster = createRedisClient(baseOptions({ ioredis: Redis, mode: 'cluster', nodes, tls: { rejectUnauthorized: true }, natMap }));
  assert.deepEqual(realCluster.client.natMapper('redis-1.internal:6379'), {
    host: 'redis-1.internal',
    port: 6379,
    tls: { rejectUnauthorized: true, servername: 'redis-1.internal' }
  });
  realCluster.force();
});

test('Redis validation, error classifier, scripts, and hash tags reject unsafe inputs', () => {
  assert.throws(() => createRedisClient(baseOptions({ mode: 'standalone', port: 70000 })), /port/);
  assert.throws(() => createRedisClient(baseOptions({ role: 'unknown' })), /role/);
  assert.throws(() => createRedisClient(baseOptions({ configId: 'short' })), /configId/);
  assert.throws(() => createRedisClient(baseOptions({ configId: '12345678 bad' })), /configId/);
  assert.equal(classifyRedisError(Object.assign(new Error('WRONGPASS invalid'), { code: 'WRONGPASS' })), 'auth');
  assert.equal(classifyRedisError(new Error('CLUSTERDOWN Hash slot not served')), 'transient');
  assert.equal(classifyRedisError(new Error('unexpected')), undefined);

  const client = new FakeRedis({});
  defineScripts(client, { append: { lua: 'return 1', numberOfKeys: 1 } });
  assert.equal(client.commands.append.numberOfKeys, 1);
  assert.throws(() => defineScripts(client, { defineCommand: { lua: '', numberOfKeys: 0 } }), /conflicts/);
  assert.throws(() => defineScripts(client, { broken: { lua: 1, numberOfKeys: -1 } }), /invalid script/);
  assert.throws(() => defineScripts({}, {}), /required/);
  assert.equal(hashTag('stream', 'group'), 'stream:{group}');
  assert.throws(() => hashTag('stream:{old}', 'group'), /without braces/);
});

test('kit does not expose data identifier or schema migration helpers', () => {
  const root = require('../..');
  const redis = require('@redkern/node-red-kit/redis');
  assert.equal('migrate' in root, false);
  assert.equal('renameIdentifier' in root, false);
  assert.equal('migrate' in redis, false);
  assert.equal('renameKey' in redis, false);
});

test('Redis validates every connection boundary and reports invalid clients', () => {
  for (const [overrides, message] of [
    [{ ioredis: class {} }, /constructor/],
    [{ domain: 'R' }, /domain/],
    [{ logger: null }, /logger/],
    [{ connectTimeout: 0 }, /connectTimeout/],
    [{ connectTimeout: 1.5 }, /connectTimeout/],
    [{ commandTimeout: 0 }, /commandTimeout/],
    [{ host: '' }, /host/],
    [{ port: 0 }, /port/],
    [{ port: 65536 }, /port/],
    [{ mode: 'sentinel' }, /mode/],
    [{ mode: 'cluster', nodes: [] }, /cluster nodes/],
    [{ mode: 'cluster', nodes: [{ host: 'redis', port: 0 }] }, /cluster nodes/],
    [{ natMap: { 'redis:6379': { host: '', port: 6379 } } }, /natMap/],
    [{ db: -1 }, /db/],
    [{ db: 1.2 }, /db/],
    [{ tls: null }, /TLS/],
    [{ tls: { rejectUnauthorized: false } }, /TLS/],
    [{ role: 'blocking', blockMs: -1 }, /blockMs/],
    [{ password: '' }, /password/]
  ]) assert.throws(() => createRedisClient(baseOptions(overrides)), message);

  class InvalidRedis {
    constructor() { return {}; }
  }
  InvalidRedis.Cluster = FakeCluster;
  assert.throws(() => createRedisClient(baseOptions({ ioredis: InvalidRedis })), /EventEmitter APIs/);
  assert.throws(() => createRedisClient(null), /options are required/);
});

test('Redis forwards client errors, retries failed connection, and supports force', async () => {
  const logged = [];
  const handle = createRedisClient(baseOptions({ logger: { error: (...args) => logged.push(args) } }));
  const error = Object.assign(new Error('connection lost'), { code: 'ECONNRESET' });
  handle.client.emit('error', error);
  assert.equal(logged[0][0], error);

  class FlakyRedis extends FakeRedis {
    async connect() {
      this.connectCount += 1;
      if (this.connectCount === 1) throw new Error('temporary connect failure');
      this.status = 'ready';
    }
  }
  FlakyRedis.Cluster = FakeCluster;
  const flaky = createRedisClient(baseOptions({ ioredis: FlakyRedis }));
  await assert.rejects(flaky.connect(), /temporary connect failure/);
  await flaky.connect();
  assert.equal(flaky.client.connectCount, 2);

  const forced = createRedisClient(baseOptions());
  forced.force();
  assert.equal(forced.client.status, 'end');
  await assert.rejects(forced.connect(), { code: 'REDIS_CLIENT_CLOSED' });
});

test('cluster retry strategy caps delay and already-ended clients close cleanly', async () => {
  const handle = createRedisClient(baseOptions({ mode: 'cluster', nodes: [{ host: 'redis', port: 6379 }] }));
  assert.equal(handle.client.options.clusterRetryStrategy(1), 1000);
  assert.equal(handle.client.options.clusterRetryStrategy(40), 30000);
  handle.client.status = 'end';
  await handle.close();
});

test('unconnected Redis handles close by disconnecting and await the end event', async () => {
  const handle = createRedisClient(baseOptions());
  await handle.close();
  assert.equal(handle.client.status, 'end');
  await handle.close();
});

test('Redis close falls back to disconnect when QUIT rejects', async () => {
  class UnavailableQuitRedis extends FakeRedis {
    async quit() { throw new Error('socket unavailable'); }
  }
  UnavailableQuitRedis.Cluster = FakeCluster;
  const handle = createRedisClient(baseOptions({ ioredis: UnavailableQuitRedis }));
  await handle.connect();
  await handle.close();
  assert.equal(handle.client.status, 'end');
});

test('Redis error classifier ignores non-string message metadata', () => {
  assert.equal(classifyRedisError({ code: 42, message: 42 }), undefined);
});