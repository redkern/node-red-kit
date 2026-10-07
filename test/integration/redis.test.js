'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const net = require('node:net');
const { once } = require('node:events');
const Redis = require('ioredis');
const { createRedisClient } = require('../../redis');

let redisProcess;
let redisPort;
let redisHost;

async function reservePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', (error) => error ? reject(error) : resolve()));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitForPort(port, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await new Promise((resolve, reject) => {
        const socket = net.createConnection({ host: '127.0.0.1', port });
        socket.once('connect', () => { socket.destroy(); resolve(); });
        socket.once('error', reject);
      });
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  throw new Error(`redis-server did not listen on ${port}`);
}

test.before(async () => {
  redisHost = process.env.REDIS_HOST || '127.0.0.1';
  if (process.env.REDIS_PORT) {
    redisPort = Number(process.env.REDIS_PORT);
  } else {
    redisPort = await reservePort();
    redisProcess = spawn('redis-server', [
      '--bind', '127.0.0.1', '--port', String(redisPort), '--save', '', '--appendonly', 'no', '--protected-mode', 'no'
    ], { stdio: 'ignore' });
  }
  await waitForPort(redisPort);
});

test.after(async () => {
  if (redisProcess && redisProcess.exitCode === null) {
    redisProcess.kill('SIGTERM');
    await Promise.race([once(redisProcess, 'exit'), new Promise((resolve) => setTimeout(resolve, 1000))]);
  }
});

test('KIT-RDS-1 standalone factory is lazy, uses role safety, executes commands, and closes', async () => {
  const logEntries = [];
  const handle = createRedisClient({
    ioredis: Redis,
    domain: 'redis',
    configId: 'integration-config-id',
    role: 'shared',
    mode: 'standalone',
    host: redisHost,
    port: redisPort,
    db: 0,
    logger: { error: (...args) => logEntries.push(args) }
  });
  try {
    assert.equal(handle.client.status, 'wait');
    await handle.connect();
    const key = `redkern-integration:${process.pid}`;
    await handle.client.set(key, 'value');
    assert.equal(await handle.client.get(key), 'value');
    const connectionName = handle.client.options.connectionName;
    assert.equal(await handle.client.client('GETNAME'), connectionName);
    const ended = once(handle.client, 'end');
    handle.client.disconnect();
    await ended;
    await handle.connect();
    assert.equal(await handle.client.client('GETNAME'), connectionName);
    await handle.close();
    assert.equal(handle.client.status, 'end');
    assert.equal(logEntries.length, 0);
  } finally {
    await handle.close();
  }
});