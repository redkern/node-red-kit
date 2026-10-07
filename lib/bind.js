'use strict';

const { createLogger, createStatus } = require('./logging.js');
const { createLifecycle } = require('./lifecycle.js');
const { createAsync } = require('./async.js');
const { ConfigError, parseConfig } = require('./config.js');
const { createNodeSecrets } = require('./secrets.js');

function bind(context, node) {
  if (typeof node.on !== 'function' || typeof node.status !== 'function') {
    throw new TypeError('node must be initialized with RED.nodes.createNode before bind');
  }
  const controller = new AbortController();
  const rawStatus = createStatus(node, context.statusOptions);
  const status = (state, text) => rawStatus(state, context.secretStore.redactText(text));
  status.dispose = rawStatus.dispose;
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
    status,
    timeoutMs: context.closeTimeoutMs
  });
  const issues = context.disabledReason?.issues ? [...context.disabledReason.issues] : [];
  let configured = false;
  let inputRegistered = false;
  let startupRegistered = false;

  function addIssue(issue) {
    if (!issues.some((existing) => existing.field === issue.field && existing.code === issue.code)) issues.push(issue);
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
      if (!context.enabled) throw new Error('metrics source is disabled');
      if (metricsLease) throw new Error('metrics lease already acquired for this node');
      metricsLease = context.metrics.acquire(node.id);
      lifecycle.onClose(metricsLease);
      return metricsLease;
    }
  } : undefined;
  const serverLeases = new Map();
  const internalServer = context.internalServer ? {
    acquire(id, value) {
      if (!context.enabled) throw new Error('internal server is disabled');
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
    sanitizeError: (error) => context.secretStore.redactValue(error)
  });

  node.on('close', (removed, done) => {
    const complete = typeof done === 'function' ? done : typeof removed === 'function' ? removed : () => {};
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
      status('error', 'CONFIG_INVALID');
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
    status(invalid || configInvalid ? 'error' : 'disabled', invalid ? 'PALETTE_DISABLED_INVALID' : configInvalid ? 'PALETTE_CONFIG_INVALID' : 'disabled');
  }
  internalServer?.onStatus((state, text) => {
    if (state === 'ok') rawStatus.clearOverlay('internal-server');
    else rawStatus.setOverlay('internal-server', state, context.secretStore.redactText(text));
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