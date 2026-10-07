'use strict';

class ConfigError extends Error {
  constructor(issues) {
    if (!Array.isArray(issues) || issues.length === 0) throw new TypeError('ConfigError requires at least one issue');
    super(issues.map((issue) => issue.message).join('; '));
    this.name = 'ConfigError';
    this.code = 'CONFIG_INVALID';
    this.issues = issues.map((issue) => ({ field: issue.field, code: issue.code, message: issue.message }));
  }
}

function readEnv(name) {
  if (typeof name !== 'string' || !name.startsWith('REDKERN_')) throw new TypeError('environment name must start with REDKERN_');
  return process.env[name];
}

/** @returns {Record<string, unknown>} */
function readSettings(RED, settingsType, schema) {
  if (typeof settingsType !== 'string' || !/^[a-z][a-z0-9-]*$/.test(settingsType)) {
    throw new TypeError('settingsType must be a Node-RED node type');
  }
  const prefix = settingsType.replace(/-([a-z0-9])/g, (_, letter) => letter.toUpperCase());
  /** @type {Record<string, unknown>} */
  const settings = {};
  for (const key of Object.keys(schema)) {
    const settingName = `${prefix}${key[0].toUpperCase()}${key.slice(1)}`;
    if (Object.hasOwn(RED.settings || {}, settingName)) settings[key] = RED.settings[settingName];
  }
  return settings;
}

/** @returns {{ ok: true, value: Record<string, unknown> } | { ok: false, errors: Array<{ field: string, code: string, message: string }> }} */
function parseConfig(config, schema) {
  /** @type {Record<string, unknown>} */
  const value = {};
  const errors = [];

  for (const [key, definition] of Object.entries(schema)) {
    validateDefinition(key, definition);
    const raw = config?.[key];
    const empty = raw === undefined || raw === null || raw === '' ||
      (definition.type !== 'str' && typeof raw === 'string' && raw.trim() === '');
    const candidate = empty ? definition.default : raw;
    if (empty && candidate === undefined) {
      if (definition.required) errors.push(issue(key, 'REQUIRED', `${key} is required`));
      else value[key] = undefined;
      continue;
    }

    if (typeof candidate === 'string') {
      const unresolved = candidate.match(/^\$\{(?:\$parent\.)?([A-Za-z_][A-Za-z0-9_]*)\}$/);
      if (unresolved) {
        errors.push(issue(key, 'ENV_UNRESOLVED', `Environment variable ${unresolved[1]} is not set`));
        continue;
      }
    }

    try {
      const converted = convert(candidate, definition);
      validateBounds(key, converted, definition);
      if (definition.type === 'list' && definition.required && Array.isArray(converted) && converted.length === 0) throw configValueError('REQUIRED', `${key} must not be empty`);
      value[key] = converted;
    } catch (error) {
      errors.push(issue(key, error.code || 'INVALID_VALUE', error.message));
    }
  }

  return errors.length ? { ok: false, errors } : { ok: true, value };
}

function convert(value, definition) {
  switch (definition.type) {
    case 'int': {
      const number = typeof value === 'number' ? value : parseNumber(value, /^[+-]?(?:0|[1-9]\d*)$/);
      if (!Number.isSafeInteger(number)) throw configValueError('INVALID_INTEGER', 'must be a safe integer');
      return number;
    }
    case 'float': {
      const number = typeof value === 'number' ? value : parseNumber(value, /^[+-]?(?:(?:\d+\.?\d*)|(?:\.\d+))(?:[eE][+-]?\d+)?$/);
      if (!Number.isFinite(number)) throw configValueError('INVALID_FLOAT', 'must be a finite number');
      return number;
    }
    case 'bool':
      if (value === true || value === 1 || /^(true|1)$/i.test(String(value).trim())) return true;
      if (value === false || value === 0 || /^(false|0)$/i.test(String(value).trim())) return false;
      throw configValueError('INVALID_BOOL', 'must be true, false, 1, or 0');
    case 'str':
      if (typeof value !== 'string') throw configValueError('INVALID_STRING', 'must be a string');
      return value;
    case 'list': {
      const list = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : null;
      if (!list || list.some((item) => typeof item !== 'string')) throw configValueError('INVALID_LIST', 'must be a list of strings');
      const items = list.map((item) => item.trim());
      if (items.some((item) => item.length === 0)) throw configValueError('INVALID_LIST', 'must not contain empty items');
      return items;
    }
    case 'enum':
      if (typeof value !== 'string' || !definition.values.includes(value)) {
        throw configValueError('INVALID_ENUM', 'must be one of the configured values');
      }
      return value;
    default:
      throw new TypeError(`Unsupported config type: ${definition.type}`);
  }
}

function validateDefinition(key, definition) {
  if (!definition || !['int', 'float', 'bool', 'str', 'list', 'enum'].includes(definition.type)) {
    throw new TypeError(`Invalid config schema for ${key}`);
  }
  if (definition.type === 'enum' && (!Array.isArray(definition.values) || definition.values.some((item) => typeof item !== 'string'))) {
    throw new TypeError(`Invalid enum schema for ${key}`);
  }
  for (const bound of ['min', 'max']) {
    if (definition[bound] !== undefined && !Number.isFinite(definition[bound])) {
      throw new TypeError(`Invalid ${bound} bound for ${key}`);
    }
  }
  if (definition.min !== undefined && definition.max !== undefined && definition.min > definition.max) {
    throw new TypeError(`Invalid bounds for ${key}`);
  }
  if (definition.default !== undefined) {
    if (definition.required && (definition.default === '' || definition.default === null || definition.default === undefined ||
        (definition.type !== 'str' && typeof definition.default === 'string' && definition.default.trim() === '') ||
        (definition.type === 'list' && Array.isArray(definition.default) && definition.default.length === 0))) {
      throw new TypeError(`Required config field ${key} cannot have an empty default`);
    }
    try {
      const converted = convert(definition.default, { ...definition, default: undefined });
      validateBounds(key, converted, definition);
    } catch (error) {
      throw new TypeError(`Invalid default for ${key}: ${error.message}`);
    }
  }
}

function validateBounds(key, value, definition) {
  const size = typeof value === 'number' ? value : typeof value === 'string' ? Array.from(value).length : Array.isArray(value) ? value.length : undefined;
  if (size === undefined) return;
  if (definition.min !== undefined && size < definition.min) throw configValueError('OUT_OF_RANGE', `${key} is below its minimum`);
  if (definition.max !== undefined && size > definition.max) throw configValueError('OUT_OF_RANGE', `${key} exceeds its maximum`);
}

function parseNumber(value, pattern) {
  if (typeof value !== 'string') throw configValueError('INVALID_NUMBER', 'must be a number');
  const normalized = value.trim();
  if (!pattern.test(normalized)) throw configValueError('INVALID_NUMBER', 'must be a complete numeric value');
  return Number(normalized);
}

function configValueError(code, message) {
  return Object.assign(new Error(message), { code });
}

function issue(field, code, message) {
  return { field, code, message };
}

module.exports = { ConfigError, parseConfig, readEnv, readSettings };