'use strict';

const BUILTIN_REDACT = Object.freeze([
  'password', 'token', 'secret', 'authorization', 'cookie', 'set-cookie',
  'privateKey', 'apiKey', 'clientSecret'
]);

function createSecretStore(fields = []) {
  if (!Array.isArray(fields) || fields.some((field) => typeof field !== 'string')) {
    throw new TypeError('redact must be an array of field names');
  }
  const sensitiveFields = new Set([...BUILTIN_REDACT, ...fields].map(normalizeField));
  const owners = new Map();

  function acquire(value) {
    if (typeof value !== 'string' || value.length === 0) return () => {};
    owners.set(value, (owners.get(value) || 0) + 1);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      const remaining = owners.get(value) - 1;
      if (remaining > 0) owners.set(value, remaining);
      else owners.delete(value);
    };
  }

  function redactText(input) {
    let text = String(input);
    for (const value of [...owners.keys()].sort((left, right) => right.length - left.length)) {
      text = text.replaceAll(value, '[REDACTED]');
      const encoded = encodeURIComponent(value);
      if (encoded !== value) text = text.replaceAll(encoded, '[REDACTED]');
    }
    return text.replace(/((?:password|token|secret|authorization|cookie|private[_-]?key|api[_-]?key)\s*[:=]\s*)([^\s,;]+)/gi, '$1[REDACTED]')
      .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1[REDACTED]');
  }

  function redactValue(value, seen = new WeakMap()) {
    if (typeof value === 'string') return redactText(value);
    if (value === null || typeof value !== 'object') return value;
    if (seen.has(value)) return '[Circular]';
    if (value instanceof Error) {
      const safe = new Error(redactText(value.message));
      seen.set(value, safe);
      safe.name = redactText(value.name);
      if (typeof /** @type {Error & { code?: string }} */ (value).code === 'string') {
        /** @type {Error & { code?: string }} */ (safe).code = redactText(/** @type {Error & { code: string }} */ (value).code);
      }
      if (typeof value.stack === 'string') safe.stack = redactText(value.stack);
      if (Object.hasOwn(value, 'cause')) safe.cause = redactValue(value.cause, seen);
      return safe;
    }
    const output = Array.isArray(value) ? [] : {};
    seen.set(value, output);
    for (const key of Object.keys(value)) {
      if (sensitiveFields.has(normalizeField(key))) output[key] = '[REDACTED]';
      else {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (descriptor && Object.hasOwn(descriptor, 'value')) output[key] = redactValue(descriptor.value, seen);
      }
    }
    return output;
  }

  return { acquire, redactText, redactValue, get size() { return owners.size; } };
}

function createNodeSecrets({ node, secretStore, log, onClose, addIssue }) {
  const leases = new Map();
  const warnedLegacy = new Set();

  function register(field, value) {
    const existing = leases.get(field);
    if (existing?.value === value) return;
    existing?.release();
    const release = secretStore.acquire(value);
    leases.set(field, { value, release });
    onClose(release);
  }

  /** @param {string} field @param {{ legacyConfig?: Record<string, unknown> }} [options] */
  function readSecret(field, { legacyConfig } = {}) {
    if (typeof field !== 'string' || field.length === 0) throw new TypeError('secret field is required');
    const credentials = node.credentials || {};
    const hasCredential = Object.hasOwn(credentials, field);
    if (hasCredential) {
      const value = typeof credentials[field] === 'string' && credentials[field].length > 0 ? credentials[field] : undefined;
      if (value) register(field, value);
      else {
        leases.get(field)?.release();
        leases.delete(field);
      }
      return value;
    }
    if (legacyConfig && Object.hasOwn(legacyConfig, field)) {
      const value = typeof legacyConfig[field] === 'string' && legacyConfig[field].length > 0 ? legacyConfig[field] : undefined;
      if (value) register(field, value);
      if (!warnedLegacy.has(field)) {
        warnedLegacy.add(field);
        log.warn(`Legacy secret field ${field} is in use; save the node to migrate it`, { key: `LEGACY_SECRET_${field}` });
      }
      return value;
    }
    leases.get(field)?.release();
    leases.delete(field);
    return undefined;
  }

  function secret(value) {
    if (typeof value !== 'string' || value.length === 0) throw new TypeError('secret value must be a non-empty string');
    const release = secretStore.acquire(value);
    let active = true;
    const releaseOnce = () => {
      if (!active) return;
      active = false;
      release();
    };
    onClose(releaseOnce);
    return releaseOnce;
  }

  function requireSecret(value, label) {
    if (typeof label !== 'string' || label.length === 0) throw new TypeError('secret label is required');
    if (typeof value !== 'string' || value.length === 0) {
      addIssue({ field: label, code: 'SECRET_REQUIRED', message: `${label} is required` });
      return false;
    }
    register(`required:${label}`, value);
    return true;
  }

  return { readSecret, secret, requireSecret };
}

function normalizeField(field) {
  return field.replace(/[-_]/g, '').toLowerCase();
}

function requireSecret(k, value, label) {
  if (!k || typeof k.requireSecret !== 'function') throw new TypeError('node context with requireSecret is required');
  return k.requireSecret(value, label);
}

module.exports = { createSecretStore, createNodeSecrets, requireSecret };