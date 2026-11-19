'use strict';

const { createLogger, createStatus } = require('./logging.js');
const { createLifecycle } = require('./lifecycle.js');
const { createAsync } = require('./async.js');
const { ConfigError, parseConfig } = require('./config.js');
const { createNodeSecrets } = require('./secrets.js');

const PRIORITY = Object.freeze({ closing: 60, config: 50, startFailed: 40, internalServer: 30, starting: 20, errors: 10 });

function bind(context, node) {
  if (typeof node.on !== 'function' || typeof node.status !== 'function') {
    throw new TypeError('node must be initialized with RED.nodes.createNode before bind');
  }
  const controller = new AbortController();
  const rawStatus = createStatus(node, context.statusOptions);
  const status = (state, text) => rawStatus(state, context.secretStore.redactText(text));
  status.dispose = rawStatus.dispose;
  const overlay = (key, state, text, priority) => rawStatus.setOverlay(key, state, context.secretStore.redactText(text), priority);
  const lifecycleStatus = (state, text, meta = {}) => {
    if (meta.phase === 'starting') overlay('starting', state, text, PRIORITY.starting);
    else if (meta.phase === 'failed') {
      rawStatus.clearOverlay('starting');
      overlay('start-failed', state, text, PRIORITY.startFailed);
    } else {
      rawStatus.clearOverlay('starting');
      status(state, text);
    }
  };
  const log = createLogger({
    RED: context.RED,
    node,
    prefix: context.names.logPrefix,
    id: node.id,
    redact: (value) => context.secretStore.redactValue(value)
  });
  const lifecycle = createLifecycle({
    signal: controller.signal,
    abort: () => controller.abort(),
    log,
    status: lifecycleStatus,
    timeoutMs: context.closeTimeoutMs,
    snapshot: () => context.secretStore.snapshot()
  });
  const issues = context.disabledReason?.issues ? [...context.disabledReason.issues] : [];
  let configured = false;
  let inputRegistered = false;
  let startupRegistered = false;

  function addIssue(issue) {
    if (!issues.some((existing) => existing.field === issue.field && existing.code === issue.code)) issues.push(issue);
    if (context.enabled) overlay('config', 'error', issue.code === 'SECRET_REQUIRED' ? 'SECRET_REQUIRED' : 'CONFIG_INVALID', PRIORITY.config);
  }

  function assertCanAcquire(service) {
    if (lifecycle.isClosing) throw new Error(`${service} cannot be acquired while the node is closing`);
    if (!context.enabled) throw new Error(`${service} is disabled`);
    if (issues.length) throw new Error(`${service} is unavailable while node configuration is invalid`);
  }

  const nodeSecrets = createNodeSecrets({
    node,
    secretStore: context.secretStore,
    log,
    onClose: (handler) => lifecycle.onClose(handler),
    addIssue
  });
  let metricsLease;
  const metrics = context.metrics ? {
    acquire() {
      assertCanAcquire('metrics source');
      if (metricsLease) throw new Error('metrics lease already acquired for this node');
      const releaseSource = context.metrics.acquire(node.id);
      let active = true;
      const release = () => {
        if (!active) return;
        active = false;
        if (metricsLease === release) metricsLease = undefined;
        releaseSource();
      };
      metricsLease = release;
      lifecycle.onClose(release);
      return release;
    }
  } : undefined;
  const serverLeases = new Map();
  const internalServer = context.internalServer ? {
    acquire(id, value) {
      assertCanAcquire('internal server');
      if (serverLeases.has(id)) throw new Error(`internal server lease already acquired: ${id}`);
      const lease = context.internalServer.acquire(id, value);
      let active = true;
      const release = async () => {
        if (!active) return false;
        active = false;
        serverLeases.delete(id);
        return lease.release();
      };
      serverLeases.set(id, release);
      lifecycle.onClose(release);
      return { ready: lease.ready, release };
    },
    release(id) {
      const release = serverLeases.get(id);
      return release ? release() : Promise.resolve(false);
    },
    onStatus(listener) {
      const unsubscribe = context.internalServer.onStatus(node.id, listener);
      lifecycle.onClose(unsubscribe);
      return unsubscribe;
    }
  } : undefined;
  const isEnabled = () => context.enabled;
  isEnabled.invalid = context.disabledReason?.code === 'PALETTE_DISABLED_INVALID';
  isEnabled.disabledReason = context.disabledReason;
  const asyncApi = createAsync({
    node,
    signal: controller.signal,
    isClosing: () => lifecycle.isClosing,
    log,
    status,
    enabled: isEnabled,
    lifecycle,
    configIssues: () => issues,
    sanitizeError: (error) => context.secretStore.redactValue(error),
    snapshot: () => context.secretStore.snapshot(),
    errorStatus: (text) => overlay('errors', 'error', text, PRIORITY.errors)
  });

  node.on('close', (removed, done) => {
    const complete = typeof done === 'function' ? done : typeof removed === 'function' ? removed : () => {};
    overlay('closing', 'idle', 'closing', PRIORITY.closing);
    lifecycle.close((error) => {
      status.dispose();
      log.dispose();
      complete(error);
    }, Boolean(removed));
  });

  function configure(config, schema) {
    if (configured) throw new TypeError('configure may only be called once');
    if (startupRegistered || inputRegistered) throw new TypeError('configure must be called before onStart and onInput');
    configured = true;
    const result = parseConfig(config, schema);
    if (result.ok === false) {
      for (const issue of result.errors) addIssue(issue);
      for (const issue of result.errors) log.error(issue.message, { key: issue.code });
    }
    return result;
  }

  function onStart(handler, options) {
    if (inputRegistered) throw new TypeError('onStart must be registered before onInput');
    startupRegistered = true;
    if (!context.enabled) return Promise.resolve(false);
    const guardedHandler = async (attempt) => {
      if (issues.length) throw new ConfigError(issues);
      return handler(attempt);
    };
    return lifecycle.onStart(guardedHandler, options);
  }

  function onInput(handler, options) {
    if (inputRegistered) throw new TypeError('onInput may only be registered once');
    const inputApi = asyncApi.onInput(handler, options);
    inputRegistered = true;
    return inputApi;
  }

  if (!context.enabled) {
    const invalid = context.disabledReason?.code === 'PALETTE_DISABLED_INVALID';
    const configInvalid = context.disabledReason?.code === 'PALETTE_CONFIG_INVALID';
    overlay('config', invalid || configInvalid ? 'error' : 'disabled', invalid ? 'PALETTE_DISABLED_INVALID' : configInvalid ? 'PALETTE_CONFIG_INVALID' : 'disabled', PRIORITY.config);
  }
  internalServer?.onStatus((state, text) => {
    if (state === 'ok') rawStatus.clearOverlay('internal-server');
    else overlay('internal-server', state, text, PRIORITY.internalServer);
  });

  return {
    configure,
    readSecret: nodeSecrets.readSecret,
    requireSecret: nodeSecrets.requireSecret,
    secret: nodeSecrets.secret,
    log,
    status,
    track: asyncApi.track,
    onInput,
    onStart,
    onClose: lifecycle.onClose,
    signal: controller.signal,
    metrics,
    internalServer
  };
}

module.exports = { bind };