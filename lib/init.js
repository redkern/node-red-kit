'use strict';

const { names } = require('./naming.js');
const { parseConfig, readEnv, readSettings } = require('./config.js');
const { bind } = require('./bind.js');
const { createLogger } = require('./logging.js');
const { createSecretStore } = require('./secrets.js');
const { createRouteRegistry } = require('./http.js');
const { createMetricsSource } = require('./metrics.js');
const { createInternalServer } = require('./internal-server.js');

function init(RED, options) {
  if (!RED || typeof RED !== 'object' || !options || typeof options !== 'object') {
    throw new TypeError('RED and init options are required');
  }
  const domainNames = names(options.domain);
  const paramsSchema = options.params || {};
  const secretsSchema = options.secrets || {};
  if (Object.hasOwn(paramsSchema, 'enabled') || Object.hasOwn(paramsSchema, 'internalPort')) {
    throw new TypeError('enabled and internalPort are reserved palette parameters');
  }
  for (const key of Object.keys(paramsSchema)) {
    if (!/^[a-z][A-Za-z0-9]*$/.test(key) || /[A-Z]{2}/.test(key)) throw new TypeError(`Invalid palette parameter name: ${key}`);
  }
  for (const [key, definition] of Object.entries(secretsSchema)) {
    if (!/^[a-z][A-Za-z0-9]*$/.test(key) || !definition || typeof definition.required !== 'boolean') {
      throw new TypeError(`Invalid secret schema for ${key}`);
    }
  }
  const internalServerOptions = options.internalServer;
  if (internalServerOptions !== undefined && (!internalServerOptions || !Number.isInteger(internalServerOptions.port))) {
    throw new TypeError('internalServer requires a palette-provided default port');
  }
  const requiredRouteTokens = new Set();
  if (internalServerOptions) {
    if (!Array.isArray(internalServerOptions.routes)) throw new TypeError('internalServer routes must be an array');
    for (const route of internalServerOptions.routes) {
      if (route.auth && typeof route.auth === 'object' && typeof route.auth.token === 'string') requiredRouteTokens.add(route.auth.token);
    }
    for (const tokenName of requiredRouteTokens) {
      if (!Object.hasOwn(secretsSchema, tokenName)) throw new TypeError(`internal route token ${tokenName} must be declared in secrets`);
    }
  }

  const secretSettingsSchema = Object.fromEntries(Object.keys(secretsSchema).map((key) => [`${key}Token`, {}]));
  const internalPortSchema = { type: 'int', min: 1, max: 65535, default: internalServerOptions?.port };
  const internalSettingsSchema = internalServerOptions ? { internalPort: internalPortSchema } : {};
  const schemaForSettings = { ...paramsSchema, ...secretSettingsSchema, ...internalSettingsSchema, enabled: { type: 'bool' } };
  /** @type {Record<string, unknown>} */
  const settings = options.settingsType
    ? readSettings(RED, options.settingsType, schemaForSettings)
    : {};
  const envValues = {};
  for (const key of Object.keys(paramsSchema)) {
    const value = readEnv(`${domainNames.envPrefix}${toEnvName(key)}`);
    if (!isEmptySource(value)) envValues[key] = value;
  }
  if (internalServerOptions) {
    const internalPort = readEnv(`${domainNames.envPrefix}INTERNAL_PORT`);
    if (!isEmptySource(internalPort)) envValues.internalPort = internalPort;
  }
  const envEnabled = readEnv(`${domainNames.envPrefix}ENABLED`);
  const settingsEnabled = isEmptySource(settings.enabled) ? undefined : settings.enabled;
  const enabledSource = !isEmptySource(envEnabled) ? envEnabled : settingsEnabled;
  const enabledValue = enabledSource === undefined ? options.enabledByDefault !== false : parseEnabled(enabledSource);
  const enabledInvalid = enabledValue === null;
  const enabled = !enabledInvalid && enabledValue;
  const enabledIssue = enabledInvalid
    ? { field: 'enabled', code: 'PALETTE_DISABLED_INVALID', message: 'Palette enabled setting is invalid' }
    : null;
  const secretStore = createSecretStore(options.redact === undefined ? [] : options.redact);
  const metrics = options.metrics === undefined ? undefined : createMetricsSource(RED, {
    domain: options.domain,
    contentType: options.metrics.contentType,
    metrics: options.metrics.metrics
  });
  const secretIssues = [];
  const secretValues = {};
  const uniqueTokens = new Set();
  if (enabled) {
    for (const [key, definition] of Object.entries(secretsSchema)) {
      const envValue = readEnv(`${domainNames.envPrefix}${toEnvName(key)}_TOKEN`);
      const settingValue = settings[`${key}Token`];
      const value = !isEmptySource(envValue) ? envValue : !isEmptySource(settingValue) ? settingValue : undefined;
      if (value === undefined) {
        if (definition.required || requiredRouteTokens.has(key)) secretIssues.push({ field: key, code: 'SECRET_REQUIRED', message: `${key} token is required` });
        continue;
      }
      if (!isValidInternalToken(value)) {
        secretIssues.push({ field: key, code: 'SECRET_INVALID', message: `${key} token must be 32-4096 printable ASCII characters without whitespace` });
        continue;
      }
      if (uniqueTokens.has(value)) {
        secretIssues.push({ field: key, code: 'SECRET_REUSED', message: `${key} token must be unique across route classes` });
        continue;
      }
      uniqueTokens.add(value);
      secretValues[key] = value;
      secretStore.acquire(value);
    }
  }

  /** @type {{ ok: true, value: Record<string, unknown> } | { ok: false, errors: Array<{ field: string, code: string, message: string }> }} */
  let config = { ok: true, value: {} };
  if (enabled) {
    const runtimeSchema = internalServerOptions ? { ...paramsSchema, internalPort: internalPortSchema } : paramsSchema;
    const values = {};
    for (const [key, definition] of Object.entries(paramsSchema)) {
      values[key] = Object.hasOwn(envValues, key)
        ? envValues[key]
        : Object.hasOwn(settings, key) && !isEmptySource(settings[key])
          ? settings[key]
          : definition.default;
    }
    if (internalServerOptions) {
      values.internalPort = Object.hasOwn(envValues, 'internalPort')
        ? envValues.internalPort
        : Object.hasOwn(settings, 'internalPort') && !isEmptySource(settings.internalPort)
          ? settings.internalPort
          : internalServerOptions.port;
    }
    config = parseConfig(values, runtimeSchema);
  } else {
    parseConfig({}, internalServerOptions ? { ...paramsSchema, internalPort: internalPortSchema } : paramsSchema);
  }
  if (enabled && secretIssues.length) {
    const existingIssues = config.ok === false ? config.errors : [];
    config = { ok: false, errors: [...existingIssues, ...secretIssues] };
  }
  const disabledReason = enabledIssue || (enabled && config.ok === false
    ? { code: 'PALETTE_CONFIG_INVALID', message: 'Palette configuration is invalid', issues: config.errors }
    : null);
  const finalEnabled = enabled && config.ok;
  const boundNodes = new WeakSet();
  const loggerRedact = (value) => secretStore.redactValue(value);
  const pluginLog = createLogger({ RED, prefix: domainNames.logPrefix, id: 'plugin', redact: loggerRedact });
  const internalServer = internalServerOptions ? createInternalServer({
    domainNames,
    port: config.ok === true && Number.isInteger(config.value.internalPort) ? config.value.internalPort : internalServerOptions.port,
    routes: internalServerOptions.routes,
    tokens: secretValues,
    tokenNames: Object.keys(secretsSchema),
    metricsContentType: metrics?.descriptor.contentType,
    log: pluginLog,
    redact: loggerRedact,
    handlerTimeoutMs: internalServerOptions.handlerTimeoutMs
  }) : undefined;
  const pluginContext = { enabled: finalEnabled, config, disabledReason, log: pluginLog };

  return {
    names: domainNames,
    config,
    enabled: finalEnabled,
    disabledReason,
    bind(node) {
      if (!node || (typeof node !== 'object' && typeof node !== 'function')) throw new TypeError('node is required');
      if (boundNodes.has(node)) throw new TypeError('node is already bound to this palette context');
      boundNodes.add(node);
      return bind({
        RED,
        names: domainNames,
        enabled: finalEnabled,
        disabledReason,
        config,
        secretStore,
        metrics,
        internalServer,
        closeTimeoutMs: options.closeTimeoutMs,
        statusOptions: options.statusOptions
      }, node);
    },
    createRouteRegistry(route) {
      return createRouteRegistry(RED, domainNames, {
        log: pluginLog,
        redact: loggerRedact,
        handlerTimeoutMs: options.handlerTimeoutMs
      }, route);
    },
    /** @param {{ id?: string }} [options] */
    plugin({ id } = {}) {
      if (typeof id !== 'string' || id.length === 0) throw new TypeError('plugin id is required');
      const log = createLogger({ RED, prefix: domainNames.logPrefix, id, redact: loggerRedact });
      return {
        log,
        signal: new AbortController().signal,
        enabled: pluginContext.enabled,
        config: pluginContext.config,
        track(promise, meta = {}) {
          return Promise.resolve(promise).then(() => true, (error) => {
            log.error(error, { key: meta.key || error.code || meta.label });
            return false;
          });
        }
      };
    }
  };
}

function parseEnabled(value) {
  if (typeof value === 'boolean') return value;
  if (value === 1 || (typeof value === 'string' && /^(true|1)$/i.test(value.trim()))) return true;
  if (value === 0 || (typeof value === 'string' && /^(false|0)$/i.test(value.trim()))) return false;
  return null;
}

function toEnvName(key) {
  return key.replace(/[A-Z]/g, (letter) => `_${letter}`).toUpperCase();
}

function isEmptySource(value) {
  return value === undefined || value === null || (typeof value === 'string' && value.trim() === '');
}

function isValidInternalToken(value) {
  return typeof value === 'string' && value.length >= 32 && value.length <= 4096 && /^[\x21-\x7E]+$/.test(value);
}

module.exports = { init };