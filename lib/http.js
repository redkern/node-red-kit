'use strict';

const { randomUUID } = require('node:crypto');
const { PublicError } = require('./auth.js');
const { readonlyMap } = require('./collections.js');

const METHODS = Object.freeze(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);

function createRouteRegistry(RED, domainNames, options, route) {
  const { log, redact, snapshot, warnOnce } = options;
  validateRoute(route, domainNames);
  const handlerTimeoutMs = route.handlerTimeoutMs ?? options.handlerTimeoutMs ?? 10000;
  if (!Number.isSafeInteger(handlerTimeoutMs) || handlerTimeoutMs < 1) throw new TypeError('handlerTimeoutMs must be a positive integer');
  const method = route.method.toLowerCase();
  const active = new Map();
  const adminDisabled = RED.settings?.httpAdminRoot === false || !RED.httpAdmin;
  const adminAuthenticated = () => Boolean(RED.settings?.adminAuth);
  const available = !adminDisabled && adminAuthenticated();
  if (adminDisabled) {
    warnOnce('ADMIN_API_DISABLED', 'Admin routes are unavailable because the Node-RED admin API is disabled');
  } else {
    if (!adminAuthenticated()) {
      warnOnce('ADMIN_AUTH_REQUIRED', 'Admin routes fail closed because adminAuth is not configured; needsPermission without adminAuth is not protection');
    }
    if (!RED.auth || typeof RED.auth.needsPermission !== 'function') throw new TypeError('RED.auth.needsPermission is required for admin routes');
    const permission = RED.auth.needsPermission(route.permission);
    if (typeof permission !== 'function') throw new TypeError('needsPermission must return middleware');
    RED.httpAdmin[method](`${domainNames.routeBase}${route.path}`, permission, (request, response) => {
      if (!adminAuthenticated()) {
        response.status(503).json({ error: 'Admin authentication is required', code: 'ADMIN_AUTH_REQUIRED' });
        return;
      }
      handleRequest({ request, response, route, active, log, redact, snapshot, handlerTimeoutMs });
    });
  }

  return {
    available,
    add(id, value) {
      if (typeof id !== 'string' || id.length === 0) throw new TypeError('route registry id is required');
      if (active.has(id)) throw new Error(`route registry id already exists: ${id}`);
      active.set(id, value);
    },
    remove(id) {
      return active.delete(id);
    },
    size() {
      return active.size;
    }
  };
}

function validateRoute(route, domainNames) {
  if (!route || typeof route !== 'object') throw new TypeError('route definition is required');
  if (typeof route.method !== 'string' || !METHODS.includes(route.method.toUpperCase())) throw new TypeError('unsupported route method');
  if (typeof route.path !== 'string' || !route.path.startsWith('/') || route.path === '/' ||
      route.path.includes('..') || /[?#*:]|\/\//.test(route.path) || route.path.endsWith('/')) {
    throw new TypeError('route path must be a static absolute suffix');
  }
  if (![domainNames.permRead, domainNames.permWrite, domainNames.permData].includes(route.permission)) {
    throw new TypeError('route permission must be explicit for this domain');
  }
  if (typeof route.handler !== 'function') throw new TypeError('route handler must be a function');
  for (const key of Object.keys(route)) {
    if (!['method', 'path', 'permission', 'handler', 'handlerTimeoutMs'].includes(key)) throw new TypeError(`Unsupported route option: ${key}`);
  }
}

function handleRequest({ request, response, route, active, log, redact, snapshot, handlerTimeoutMs }) {
  const requestId = randomUUID();
  const redactor = snapshot();
  const safe = (value) => redact(redactor.redactValue(value));
  const abortController = new AbortController();
  let responded = false;
  let clientGone = false;
  const onClose = () => {
    if (!response.writableEnded) {
      clientGone = true;
      abortController.abort();
    }
  };
  response.once('close', onClose);

  function sendJson(statusCode, body) {
    if (responded || response.headersSent) return;
    responded = true;
    response.status(statusCode).json(safe(body));
  }

  const facade = {
    status(statusCode) {
      if (!Number.isInteger(statusCode) || statusCode < 100 || statusCode > 599) throw new TypeError('invalid response status');
      response.status(statusCode);
      return facade;
    },
    setHeader(name, value) {
      if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) || /[\r\n]/.test(String(value)) || name.toLowerCase() === 'set-cookie') {
        throw new TypeError('invalid response header');
      }
      if (responded || response.headersSent) return facade;
      response.setHeader(name, value);
      return facade;
    },
    json(value) {
      sendJson(response.statusCode || 200, value);
      return facade;
    },
    text(value, contentType = 'text/plain; charset=utf-8') {
      if (responded || response.headersSent) return facade;
      if (typeof contentType !== 'string' || /openmetrics/i.test(contentType) || /(^|;)\s*version\s*=\s*"?0\.0\.4"?\s*(?:;|$)/i.test(contentType)) {
        throw new TypeError('metrics content type requires the metrics facade');
      }
      responded = true;
      response.type(contentType).send(safe(value));
      return facade;
    }
  };

  const normalizedRequest = {
    method: request.method,
    path: request.path,
    query: request.query,
    headers: request.headers,
    body: request.body,
    signal: abortController.signal
  };

  Promise.resolve().then(async () => {
    if (abortController.signal.aborted) return;
    if (active.size === 0) return sendJson(503, { error: 'No active entries', code: 'NO_ACTIVE_ENTRIES' });
    if (requiresJson(route.method, request) && !isJsonRequest(request)) return sendJson(415, { error: 'Unsupported media type', code: 'JSON_REQUIRED' });
    const operation = Promise.resolve().then(() => route.handler(normalizedRequest, facade, readonlyMap(active)));
    try {
      await withHandlerTimeout(operation, handlerTimeoutMs, abortController);
    } catch (error) {
      if (error?.code === 'HTTP_HANDLER_TIMEOUT') watchLate(operation, requestId, log);
      throw error;
    }
    if (!responded && !response.headersSent) throw new Error('Handler did not send a response');
  }).catch((error) => {
    const code = typeof error?.code === 'string' ? error.code : undefined;
    if (clientGone && error?.name === 'AbortError') return;
    if (response.headersSent || responded) {
      response.destroy();
      log.error(`HTTP request ${requestId} failed after response started`, { key: code || 'HTTP_LATE_FAILURE' });
      return;
    }
    if (error instanceof PublicError) {
      sendJson(error.status, { error: error.message, ...(error.code ? { code: error.code } : {}) });
      return;
    }
    log.error(`HTTP request ${requestId} failed: ${redactor.redactValue(String(error?.message ?? error))}`, { key: code || 'HTTP_INTERNAL_ERROR' });
    sendJson(code === 'HTTP_HANDLER_TIMEOUT' ? 504 : 500, { error: 'Internal error', id: requestId });
  }).finally(() => {
    response.removeListener('close', onClose);
    redactor.release();
  });
}

function watchLate(operation, operationId, log) {
  operation.then(
    () => log.warn(`Late HTTP operation ${operationId} completed`, { key: 'LATE_OPERATION_COMPLETED' }),
    () => log.warn(`Late HTTP operation ${operationId} failed`, { key: 'LATE_OPERATION_FAILED' })
  );
}

function isWriteMethod(method) {
  return ['POST', 'PUT', 'PATCH'].includes(method.toUpperCase());
}

function requiresJson(method, request) {
  if (isWriteMethod(method)) return true;
  if (method.toUpperCase() !== 'DELETE') return false;
  const contentLength = Number(request.headers?.['content-length'] || 0);
  return contentLength > 0 || Boolean(request.headers?.['transfer-encoding']);
}

function isJsonRequest(request) {
  const header = request.headers?.['content-type'];
  if (typeof header !== 'string') return false;
  const parts = header.split(';').map((part) => part.trim());
  if (parts.shift().toLowerCase() !== 'application/json') return false;
  const parameters = parts.map((part) => part.match(/^([^=]+)=(.*)$/)).filter(Boolean);
  if (parameters.length !== parts.length) return false;
  const charsets = parameters.filter(([, name]) => name.toLowerCase() === 'charset');
  return charsets.length <= 1 && parameters.every(([, name, value]) => name.toLowerCase() === 'charset' && value.replace(/^"|"$/g, '').toLowerCase() === 'utf-8');
}

function withHandlerTimeout(promise, timeoutMs, controller) {
  let timer;
  let abort;
  const { signal } = controller;
  const work = Promise.resolve(promise);
  work.catch(() => {});
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      controller.abort();
      reject(Object.assign(new Error('HTTP handler timed out'), { code: 'HTTP_HANDLER_TIMEOUT' }));
    }, timeoutMs);
    abort = () => reject(Object.assign(new Error('HTTP request aborted'), { name: 'AbortError', code: 'ABORT_ERR' }));
    // handleRequest returns early when the client is gone, so the signal is not aborted yet here.
    signal.addEventListener('abort', abort, { once: true });
  });
  return Promise.race([work, timeout]).finally(() => {
    clearTimeout(timer);
    signal.removeEventListener('abort', abort);
  });
}

module.exports = { createRouteRegistry };