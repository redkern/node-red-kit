'use strict';

const { names, instanceId } = require('./lib/naming.js');
const { withTimeout } = require('./lib/resilience.js');

const ROLES = new Set(['shared', 'blocking', 'subscriber']);

/**
 * @param {{ ioredis: any, domain: string, configId: string, role: 'shared'|'blocking'|'subscriber', mode: 'standalone'|'cluster', host?: string, port?: number, nodes?: Array<{ host: string, port: number }>, natMap?: Record<string, { host: string, port: number }>, db?: number, tls?: object, username?: string, password?: string, connectTimeout?: number, commandTimeout?: number, blockMs?: number, logger: { error: Function } }} options
 * @returns {{ client: any, connect: () => Promise<void>, close: () => Promise<void>, force: () => void }}
 */
function createRedisClient(options) {
  validateOptions(options);
  const {
    ioredis, domain, configId, role, mode, host, port, nodes, natMap, db = 0,
    tls, username, password, connectTimeout = 10000, commandTimeout, blockMs = 0, logger
  } = options;
  if (mode === 'cluster' && db !== 0) throw configError('Redis Cluster only supports database 0');
  if (password !== undefined && (typeof password !== 'string' || password.length === 0)) throw configError('password must be a non-empty string');

  const connectionName = `redkern-${domain}-${role}-${configId.slice(0, 8)}-${instanceId()}`;
  const roleOptions = {
    lazyConnect: true,
    enableOfflineQueue: false,
    autoResendUnfulfilledCommands: false,
    connectTimeout,
    username,
    password,
    connectionName
  };
  if (role === 'shared') {
    roleOptions.enableAutoPipelining = true;
    roleOptions.maxRetriesPerRequest = 3;
    roleOptions.commandTimeout = commandTimeout === undefined ? 5000 : commandTimeout;
  } else if (role === 'blocking') {
    roleOptions.enableAutoPipelining = false;
    roleOptions.maxRetriesPerRequest = null;
    if (commandTimeout !== undefined) {
      if (commandTimeout <= blockMs) throw configError('blocking commandTimeout must exceed BLOCK duration');
      roleOptions.commandTimeout = commandTimeout;
    }
  } else {
    roleOptions.enableAutoPipelining = false;
    roleOptions.maxRetriesPerRequest = null;
    roleOptions.autoResubscribe = true;
  }
  if (tls) roleOptions.tls = { ...tls };

  let client;
  if (mode === 'standalone') {
    client = new ioredis({
      ...roleOptions,
      host,
      port,
      db,
      retryStrategy: (attempt) => Math.min(attempt * 1000, 30000)
    });
  } else {
    const clusterOptions = {
      clusterRetryStrategy: (attempt) => Math.min(1000 * attempt, 30000),
      lazyConnect: true,
      enableOfflineQueue: false,
      enableReadyCheck: false,
      slotsRefreshTimeout: connectTimeout,
      ...(natMap ? { natMap: Object.fromEntries(Object.entries(natMap).map(([address, target]) => [address, {
        ...target,
        ...(tls ? { tls: { ...tls, servername: target.host } } : {})
      }])) } : {}),
      redisOptions: {
        ...roleOptions,
        enableOfflineQueue: true,
        ...(tls ? { tls: { ...tls } } : {})
      }
    };
    const startupNodes = tls
      ? nodes.map((node) => ({ ...node, tls: { ...tls, servername: node.host } }))
      : nodes;
    client = new ioredis.Cluster(startupNodes, clusterOptions);
  }

  if (!client || typeof client.on !== 'function') throw new TypeError('ioredis client must expose EventEmitter APIs');
  client.on('error', (error) => logger.error(error, { key: `${role}:${configId}` }));
  let connecting;
  let closed = false;

  return {
    client,
    async connect() {
      if (closed) throw Object.assign(new Error('Redis client is closed'), { code: 'REDIS_CLIENT_CLOSED' });
      if (client.status === 'ready') {
        if (mode === 'cluster') await verifyClusterReady(client, connectTimeout);
        return;
      }
      if (!connecting) {
        const start = client.status === 'wait' || client.status === 'end'
          ? Promise.resolve().then(() => client.connect())
          : waitForReady(client, connectTimeout);
        connecting = start.then(async () => {
          if (mode === 'cluster') await verifyClusterReady(client, connectTimeout);
        }).finally(() => { connecting = undefined; });
      }
      return connecting;
    },
    async close() {
      if (closed) return;
      closed = true;
      const ended = client.status === 'end'
        ? Promise.resolve()
        : new Promise((resolve) => client.once('end', resolve));
      if (client.status === 'ready' && typeof client.quit === 'function') {
        try { await client.quit(); } catch { client.disconnect?.(); }
      }
      if (client.status !== 'end' && typeof client.disconnect === 'function') client.disconnect();
      await withTimeout(ended, connectTimeout, { code: 'REDIS_CLOSE_TIMEOUT' });
    },
    force() {
      closed = true;
      if (typeof client.disconnect === 'function') client.disconnect();
    }
  };
}

async function verifyClusterReady(client, timeoutMs) {
  const info = await withTimeout(client.cluster('INFO'), timeoutMs, { code: 'REDIS_CLUSTER_READY_TIMEOUT' });
  if (typeof info !== 'string' || !/(?:^|\r\n)cluster_state:ok(?:\r\n|$)/.test(info)) {
    throw Object.assign(new Error('Redis Cluster is not ready'), { code: 'REDIS_CLUSTER_NOT_READY' });
  }
}

function waitForReady(client, timeoutMs) {
  return new Promise((resolve, reject) => {
    let timer;
    const cleanup = () => {
      clearTimeout(timer);
      client.removeListener('ready', ready);
      client.removeListener('end', ended);
    };
    const ready = () => { cleanup(); resolve(); };
    const ended = () => {
      cleanup();
      reject(Object.assign(new Error('Redis client ended before becoming ready'), { code: 'REDIS_CONNECT_CLOSED' }));
    };
    client.once('ready', ready);
    client.once('end', ended);
    timer = setTimeout(() => {
      cleanup();
      reject(Object.assign(new Error('Redis connection timed out'), { code: 'REDIS_CONNECT_TIMEOUT' }));
    }, timeoutMs);
    if (client.status === 'ready') ready();
    else if (client.status === 'end') ended();
  });
}

function classifyRedisError(error) {
  const code = typeof error?.code === 'string' ? error.code : '';
  const message = typeof error?.message === 'string' ? error.message : '';
  const value = `${code} ${message}`.trim().toUpperCase();
  if (/^(WRONGPASS|NOAUTH)(?:\s|$)/.test(value)) return 'auth';
  if (/^(LOADING|CLUSTERDOWN|TRYAGAIN)(?:\s|$)/.test(value)) return 'transient';
  return undefined;
}

function defineScripts(client, scripts) {
  if (!client || typeof client.defineCommand !== 'function' || !scripts || typeof scripts !== 'object') {
    throw new TypeError('client and script definitions are required');
  }
  for (const [name, script] of Object.entries(scripts)) {
    if (!/^[A-Za-z][A-Za-z0-9]*$/.test(name) || name in client) throw new TypeError(`script name conflicts with client API: ${name}`);
    if (!script || typeof script.lua !== 'string' || !Number.isSafeInteger(script.numberOfKeys) || script.numberOfKeys < 0) {
      throw new TypeError(`invalid script definition: ${name}`);
    }
    client.defineCommand(name, { lua: script.lua, numberOfKeys: script.numberOfKeys });
  }
}

function hashTag(base, tag) {
  if (typeof base !== 'string' || base.length === 0 || typeof tag !== 'string' || tag.length === 0 || /[{}]/.test(base) || /[{}]/.test(tag)) {
    throw new TypeError('base and tag must be non-empty strings without braces');
  }
  return `${base}:{${tag}}`;
}

function validateOptions(options) {
  if (!options || typeof options !== 'object') throw new TypeError('Redis options are required');
  if (typeof options.ioredis !== 'function' || typeof options.ioredis.Cluster !== 'function') {
    throw new TypeError('ioredis constructor and Cluster constructor are required');
  }
  names(options.domain);
  if (typeof options.configId !== 'string' || options.configId.length < 8 || !/^[A-Za-z0-9_-]+$/.test(options.configId)) throw new TypeError('configId must contain at least 8 safe characters');
  if (!ROLES.has(options.role)) throw new TypeError('invalid Redis connection role');
  if (!['standalone', 'cluster'].includes(options.mode)) throw new TypeError('invalid Redis mode');
  if (!options.logger || typeof options.logger.error !== 'function') throw new TypeError('Redis logger is required');
  const connectTimeout = options.connectTimeout === undefined ? 10000 : options.connectTimeout;
  if (!Number.isSafeInteger(connectTimeout) || connectTimeout < 1) throw new TypeError('connectTimeout must be a positive integer');
  if (options.commandTimeout !== undefined && (!Number.isSafeInteger(options.commandTimeout) || options.commandTimeout < 1)) {
    throw new TypeError('commandTimeout must be a positive integer');
  }
  if (options.mode === 'standalone') {
    if (typeof options.host !== 'string' || options.host.length === 0) throw new TypeError('standalone host is required');
    if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535) throw new TypeError('standalone port is invalid');
  } else if (!Array.isArray(options.nodes) || options.nodes.length === 0 || options.nodes.some((node) => !node || typeof node.host !== 'string' || !Number.isInteger(node.port) || node.port < 1 || node.port > 65535)) {
    throw new TypeError('cluster nodes are required and must be valid');
  }
  if (options.natMap !== undefined && (!options.natMap || typeof options.natMap !== 'object' || Array.isArray(options.natMap)
    || Object.entries(options.natMap).some(([address, target]) => !address || !target || typeof target.host !== 'string' || !target.host
      || !Number.isInteger(target.port) || target.port < 1 || target.port > 65535))) {
    throw new TypeError('natMap must map advertised addresses to valid hosts and ports');
  }
  if (options.db !== undefined && (!Number.isSafeInteger(options.db) || options.db < 0)) throw new TypeError('db must be a non-negative integer');
  if (options.tls !== undefined && (!options.tls || typeof options.tls !== 'object' || options.tls.rejectUnauthorized === false)) {
    throw new TypeError('TLS must be an object with certificate verification enabled');
  }
  if (options.role === 'blocking' && options.blockMs !== undefined && (!Number.isSafeInteger(options.blockMs) || options.blockMs < 0)) {
    throw new TypeError('blockMs must be a non-negative integer');
  }
}

function configError(message) {
  return Object.assign(new Error(message), { name: 'ConfigError', code: 'CONFIG_INVALID' });
}

module.exports = { createRedisClient, classifyRedisError, defineScripts, hashTag };