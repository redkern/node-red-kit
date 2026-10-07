'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { once } = require('node:events');
const Redis = require('ioredis');
const { createRedisClient } = require('../../redis');

const nodes = ['redis-1', 'redis-2', 'redis-3'].map((host) => ({ host, port: 6379 }));
const natMap = Object.fromEntries(Array.from({ length: 6 }, (_, index) => [
  `redis-${index + 1}:6379`,
  { host: `redis-${index + 1}`, port: 6379 }
]));
const ca = fs.readFileSync(process.env.REDKERN_TEST_CA_FILE);
const errors = [];

function createClusterHandle() {
  return createRedisClient({
    ioredis: Redis,
    domain: 'redis',
    configId: 'cluster-integration-config',
    role: 'shared',
    mode: 'cluster',
    nodes,
    natMap,
    tls: { ca, rejectUnauthorized: true },
    logger: { error: (error) => errors.push(error) }
  });
}

async function waitFor(predicate, label, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function toxiproxy(method, pathname, body) {
  const response = await fetch(`${process.env.REDKERN_TOXIPROXY_URL}${pathname}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined
  });
  if (!response.ok) throw new Error(`Toxiproxy ${method} ${pathname} failed: ${response.status} ${await response.text()}`);
  return response.status === 204 ? undefined : response.json();
}

test('KIT-RDS-9 validates a TLS Redis Cluster, replica failover, and fault-proxy reconnect', async () => {
  const seedProbe = new Redis({
    host: 'redis-1',
    port: 6379,
    lazyConnect: true,
    enableOfflineQueue: false,
    autoResendUnfulfilledCommands: false,
    connectTimeout: 10000,
    connectionName: 'redkern-redis-shared-cluster-probe',
    enableAutoPipelining: true,
    maxRetriesPerRequest: 3,
    commandTimeout: 5000,
    tls: { ca, rejectUnauthorized: true }
  });
  await seedProbe.connect();
  assert.equal(await seedProbe.ping(), 'PONG');
  const seedSlots = await seedProbe.cluster('slots');
  assert.equal(seedSlots.length, 3);
  assert.deepEqual(new Set(seedSlots.map(([, , master]) => master[0])), new Set(['redis-1', 'redis-2', 'redis-3']));
  const refresher = seedProbe.duplicate({
    enableOfflineQueue: true,
    enableReadyCheck: false,
    retryStrategy: null,
    protocol: 2,
    replyMapping: 'legacy',
    connectionName: 'redkern-cluster-refresher'
  });
  try {
    assert.equal((await refresher.cluster('SLOTS')).length, 3);
  } finally {
    refresher.disconnect();
  }
  await seedProbe.quit();

  const handle = createClusterHandle();
  assert.deepEqual(handle.client.natMapper({ host: 'redis-1', port: 6379 }), {
    host: 'redis-1',
    port: 6379,
    tls: { ca, rejectUnauthorized: true, servername: 'redis-1' }
  });
  let replicaHandle;
  let proxyHandle;
  let phase = 'cluster connect';
  const nodeErrors = [];
  try {
    handle.client.connectionPool.on('+node', (client, address) => {
      client.on('error', (error) => nodeErrors.push(`${address}: ${error.code || error.name}: ${error.message}`));
    });
    handle.client.connectionPool.on('nodeError', (error, address) => nodeErrors.push(`${address}: ${error.code || error.name}: ${error.message}`));
    handle.client.on('node error', (error, address) => nodeErrors.push(`${address}: ${error.message}`));
    await handle.connect();
    const masters = handle.client.nodes('master');
    const replicas = handle.client.nodes('slave');
    assert.equal(masters.length, 3, JSON.stringify({
      status: handle.client.status,
      all: handle.client.nodes().length,
      masters: masters.length,
      replicas: replicas.length,
      slots: handle.client.slots.filter(Boolean).length
    }));
    assert.equal(await Promise.all(masters.map((client) => client.ping())).then((replies) => replies.every((reply) => reply === 'PONG')), true);
    replicaHandle = createRedisClient({
      ioredis: Redis,
      domain: 'redis',
      configId: 'replica-failover-integration',
      role: 'shared',
      mode: 'standalone',
      host: 'redis-4',
      port: 6379,
      tls: { ca, rejectUnauthorized: true, servername: 'redis-4' },
      logger: { error: (error) => errors.push(error) }
    });
    await replicaHandle.connect();
    assert.match(await replicaHandle.client.info('replication'), /role:slave/);

    const key = `redkern-cluster:${process.pid}`;
    await handle.client.set(key, 'before-failover');
    assert.equal(await handle.client.get(key), 'before-failover');
    phase = 'replica failover';
    await replicaHandle.client.cluster('failover', 'force');
    await waitFor(async () => {
      try {
        await handle.client.set(key, 'after-failover');
        return await handle.client.get(key) === 'after-failover';
      } catch {
        return false;
      }
    }, 'cluster replica promotion');

    phase = 'configure Toxiproxy';
    await toxiproxy('POST', '/proxies', {
      name: 'redis-tls-fault',
      listen: '0.0.0.0:26379',
      upstream: 'redis-1:6379',
      enabled: true
    });
    proxyHandle = createRedisClient({
      ioredis: Redis,
      domain: 'redis',
      configId: 'fault-proxy-integration',
      role: 'shared',
      mode: 'standalone',
      host: 'toxiproxy',
      port: 26379,
      tls: { ca, rejectUnauthorized: true, servername: 'redis-1' },
      logger: { error: (error) => errors.push(error) }
    });
    await proxyHandle.connect();
    assert.equal(await proxyHandle.client.ping(), 'PONG');
    const connectionName = await proxyHandle.client.client('GETNAME');
    assert.equal(connectionName, proxyHandle.client.options.connectionName);

    phase = 'reset proxy stream';
    const closed = new Promise((resolve) => proxyHandle.client.once('close', resolve));
    await toxiproxy('POST', '/proxies/redis-tls-fault/toxics', {
      name: 'reset-peer',
      type: 'reset_peer',
      stream: 'downstream',
      toxicity: 1,
      attributes: { timeout: 1 }
    });
    const interruptedPing = proxyHandle.client.ping().catch(() => undefined);
    await Promise.race([
      closed,
      new Promise((_, reject) => setTimeout(() => reject(new Error('Toxiproxy did not reset the Redis stream')), 5000))
    ]);
    await interruptedPing;
    await toxiproxy('DELETE', '/proxies/redis-tls-fault/toxics/reset-peer');
    phase = 'reconnect through proxy';
    const ready = once(proxyHandle.client, 'ready');
    await Promise.race([
      ready,
      new Promise((_, reject) => setTimeout(() => reject(new Error('Redis client did not reconnect through Toxiproxy')), 10000))
    ]);
    assert.equal(await proxyHandle.client.client('GETNAME'), connectionName);
    assert.equal(await proxyHandle.client.ping(), 'PONG');
  } catch (error) {
    const lastNodeError = error.lastNodeError?.message;
    const diagnostics = [...errors.map((entry) => `${entry.code || 'ERROR'}: ${entry.message}`), ...nodeErrors].join('; ');
    throw new Error(`KIT-RDS-9 failed during ${phase}: ${error.message}${lastNodeError ? `; last node: ${lastNodeError}` : ''}${diagnostics ? `; client errors: ${diagnostics}` : ''}`, { cause: error });
  } finally {
    proxyHandle?.force();
    replicaHandle?.force();
    handle.force();
    assert.ok(errors.every((error) => error && typeof error.message === 'string'));
  }
});