'use strict';

const http = require('node:http');
const { backoff, sleep, withTimeout } = require('./resilience.js');
const { extractToken, secureCompare, PublicError } = require('./auth.js');
const { readonlyMap } = require('./collections.js');

const BODY_LIMIT = 1024 * 1024;
const REQUEST_LIMIT = 64;
const LOOPBACK = Object.freeze(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

function createInternalServer({ domainNames, port, routes, tokens = {}, tokenNames = Object.keys(tokens), metricsContentType, log, redact = (value) => value, handlerTimeoutMs = 10000 }) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new TypeError('internal port must be between 1 and 65535');
  if (!Array.isArray(routes) || routes.length === 0) throw new TypeError('internal routes must be a non-empty array');
  if (!Number.isSafeInteger(handlerTimeoutMs) || handlerTimeoutMs < 1) throw new TypeError('handlerTimeoutMs must be a positive integer');

  const normalizedRoutes = new Map();
  let localRoutes = 0;
  let tokenRoutes = 0;
  for (const route of routes) {
    validateRoute(route, domainNames, tokenNames);
    const path = `${domainNames.routeBase}${route.path}`;
    const key = `${route.method.toUpperCase()} ${path}`;
    if (normalizedRoutes.has(key)) throw new TypeError(`duplicate internal route: ${key}`);
    normalizedRoutes.set(key, route);
    if (route.auth === 'local') localRoutes += 1;
    else tokenRoutes += 1;
  }
  if (localRoutes > 0 && tokenRoutes > 0) throw new TypeError('local and token routes cannot share an internal listener');

  const host = tokenRoutes > 0 ? '0.0.0.0' : '127.0.0.1';
  const owners = new Map();
  const statusListeners = new Map();
  let server;
  let controller;
  let startup;
  let ready;
  let resolveReady;
  let rejectReady;
  let readySettled = false;
  let activeRequests = 0;

  function newReady() {
    readySettled = false;
    ready = new Promise((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    ready.catch(() => {});
    return ready;
  }

  function listenOnce(instance) {
    return new Promise((resolve, reject) => {
      const failed = (error) => {
        instance.removeListener('listening', listening);
        reject(error);
      };
      const listening = () => {
        instance.removeListener('error', failed);
        resolve();
      };
      instance.once('error', failed);
      instance.once('listening', listening);
      try {
        instance.listen({ host, port, exclusive: true });
      } catch (error) {
        failed(error);
      }
    });
  }

  async function startLoop(signal) {
    const delay = backoff({ initial: 1000, max: 30000, jitter: 'full' });
    while (owners.size > 0 && !signal.aborted) {
      const instance = http.createServer({ maxHeaderSize: 16 * 1024 }, (request, response) => dispatch(request, response));
      instance.on('error', (error) => {
        if (instance.listening) {
          log.error(error, { key: /** @type {Error & { code?: string }} */ (error).code || 'INTERNAL_SERVER_ERROR' });
          instance.close();
        }
      });
      instance.maxHeadersCount = 100;
      instance.headersTimeout = 10000;
      instance.requestTimeout = 30000;
      instance.maxConnections = REQUEST_LIMIT + 1;
      try {
        await listenOnce(instance);
        if (signal.aborted || owners.size === 0) {
          await closeServer(instance, 1000);
          break;
        }
        server = instance;
        delay.reset();
        publishStatus('ok', 'internal ready');
        if (!readySettled) {
          readySettled = true;
          resolveReady();
        }
        await new Promise((resolve) => instance.once('close', resolve));
        if (owners.size > 0 && !signal.aborted) {
          log.error('Internal server closed unexpectedly', { key: 'INTERNAL_SERVER_CLOSED' });
          publishStatus('error', 'INTERNAL_SERVER_CLOSED');
        }
      } catch (error) {
        if (instance.listening) await closeServer(instance, 1000);
        if (!signal.aborted && owners.size > 0) {
          log.error(error, { key: error.code || 'INTERNAL_SERVER_LISTEN' });
          publishStatus('error', error.code || 'INTERNAL LISTEN');
        }
      }
      if (server === instance) server = undefined;
      if (owners.size > 0 && !signal.aborted) {
        try { await sleep(delay.next(), signal); } catch (error) {
          if (error.name !== 'AbortError') throw error;
        }
      }
    }
  }

  function publishStatus(state, text) {
    for (const listener of statusListeners.values()) {
      try { listener(state, text); } catch (error) { log.error(error, { key: 'INTERNAL_STATUS_LISTENER' }); }
    }
  }

  async function closeServer(instance, timeoutMs) {
    if (!instance || !instance.listening) return;
    const closing = new Promise((resolve) => instance.close(() => resolve()));
    instance.closeIdleConnections?.();
    try {
      await withTimeout(closing, timeoutMs, { code: 'INTERNAL_SERVER_CLOSE_TIMEOUT' });
    } catch {
      instance.closeAllConnections?.();
      await Promise.race([closing, new Promise((resolve) => setTimeout(resolve, 100))]);
    }
  }

  async function dispatch(request, response) {
    if (activeRequests >= REQUEST_LIMIT) return writeJson(response, 503, { error: 'Server busy', code: 'SERVER_BUSY' });
    activeRequests += 1;
    try {
      const requestUrl = new URL(request.url, 'http://127.0.0.1');
      const route = normalizedRoutes.get(`${request.method} ${requestUrl.pathname}`);
      if (!route) return writeJson(response, 404, { error: 'Not found', code: 'NOT_FOUND' });
      if (!authorized(request, route.auth, tokens)) return writeJson(response, 401, { error: 'Unauthorized', code: 'UNAUTHORIZED' });
      if (requiresJson(route.method, request) && !isJsonRequest(request.headers['content-type'])) {
        return writeJson(response, 415, { error: 'Unsupported media type', code: 'JSON_REQUIRED' });
      }
      const body = await readBody(request);
      const controllerForRequest = new AbortController();
      const onAborted = () => controllerForRequest.abort();
      request.once('aborted', onAborted);
      response.once('close', onAborted);
      const facade = makeResponseFacade(response, redact, metricsContentType);
      const normalizedRequest = {
        method: request.method,
        path: requestUrl.pathname,
        query: Object.fromEntries(requestUrl.searchParams),
        headers: request.headers,
        body,
        signal: controllerForRequest.signal
      };
      try {
        await withHandlerTimeout(route.handler(normalizedRequest, facade, readonlyMap(owners)), handlerTimeoutMs, controllerForRequest);
        if (!facade.responded && !response.headersSent) throw new Error('Handler did not send a response');
      } catch (error) {
        if (response.headersSent) {
          response.destroy();
        } else if (error instanceof PublicError) {
          writeJson(response, error.status, { error: error.message, ...(error.code ? { code: error.code } : {}) }, redact);
        } else {
          const requestId = require('node:crypto').randomUUID();
          log.error(`Internal request ${requestId} failed: ${error.message}`, { key: error.code || 'INTERNAL_REQUEST_FAILED' });
          writeJson(response, error.code === 'HTTP_HANDLER_TIMEOUT' ? 504 : 500, { error: 'Internal error', id: requestId }, redact);
        }
      } finally {
        request.removeListener('aborted', onAborted);
        response.removeListener('close', onAborted);
      }
    } catch (error) {
      if (response.headersSent) response.destroy();
      else {
        log.error(error, { key: error.code || 'INTERNAL_REQUEST_FAILED' });
        writeJson(response, error.statusCode || 400, { error: error.statusCode === 413 ? 'Payload too large' : 'Invalid request', code: error.code || 'INVALID_REQUEST' }, redact);
      }
    } finally {
      activeRequests -= 1;
    }
  }

  return {
    host,
    port,
    acquire(id, value) {
      if (typeof id !== 'string' || id.length === 0) throw new TypeError('internal server owner id is required');
      if (owners.has(id)) throw new Error(`internal server lease already exists: ${id}`);
      owners.set(id, value);
      if (owners.size === 1) {
        controller = new AbortController();
        const readyPromise = newReady();
        startup = startLoop(controller.signal);
        startup.catch((error) => {
          if (!readySettled) {
            readySettled = true;
            rejectReady(error);
          }
          log.error(error, { key: error.code || 'INTERNAL_SERVER_FAILED' });
        });
        const release = () => releaseOwner(id);
        return { ready: readyPromise, release };
      }
      return { ready, release: () => releaseOwner(id) };
    },
    async release(id) {
      return releaseOwner(id);
    },
    size() { return owners.size; },
    onStatus(id, listener) {
      if (typeof id !== 'string' || id.length === 0 || typeof listener !== 'function') throw new TypeError('status owner id and listener are required');
      if (statusListeners.has(id)) throw new Error(`internal server status listener already exists: ${id}`);
      statusListeners.set(id, listener);
      let active = true;
      return () => {
        if (!active) return;
        active = false;
        statusListeners.delete(id);
      };
    }
  };

  async function releaseOwner(id) {
    if (!owners.delete(id)) return false;
    if (owners.size > 0) return true;
    controller?.abort();
    if (!readySettled) {
      readySettled = true;
      rejectReady(Object.assign(new Error('Internal server lease released before ready'), { code: 'INTERNAL_SERVER_CLOSED' }));
    }
    await closeServer(server, 10000);
    await startup?.catch(() => {});
    return true;
  }
}

function validateRoute(route, names, tokenNames) {
  if (!route || typeof route !== 'object') throw new TypeError('internal route definition is required');
  if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(String(route.method).toUpperCase())) throw new TypeError('unsupported internal route method');
  if (typeof route.path !== 'string' || !route.path.startsWith('/') || route.path === '/' || route.path.includes('..') || /[?#*:]|\/\//.test(route.path) || route.path.endsWith('/')) {
    throw new TypeError('internal route path must be a static absolute suffix');
  }
  if (route.auth !== 'local' && (!route.auth || typeof route.auth.token !== 'string' || !tokenNames.includes(route.auth.token))) {
    throw new TypeError('internal route requires local auth or a declared token');
  }
  if (typeof route.handler !== 'function') throw new TypeError('internal route handler must be a function');
}

function authorized(request, auth, tokens) {
  if (auth === 'local') return LOOPBACK.includes(request.socket.remoteAddress);
  const provided = extractToken(request);
  const expected = tokens[auth.token];
  return typeof expected === 'string' && secureCompare(expected, provided);
}

function requiresJson(method, request) {
  if (['POST', 'PUT', 'PATCH'].includes(method.toUpperCase())) return true;
  if (method.toUpperCase() !== 'DELETE') return false;
  return Number(request.headers['content-length'] || 0) > 0 || Boolean(request.headers['transfer-encoding']);
}

function isJsonRequest(contentType) {
  if (typeof contentType !== 'string') return false;
  const parts = contentType.split(';').map((part) => part.trim());
  if (parts.shift().toLowerCase() !== 'application/json') return false;
  const parameters = parts.map((part) => part.match(/^([^=]+)=(.*)$/)).filter(Boolean);
  if (parameters.length !== parts.length) return false;
  const charsets = parameters.filter(([, name]) => name.toLowerCase() === 'charset');
  return charsets.length <= 1 && parameters.every(([, name, value]) => name.toLowerCase() === 'charset' && value.replace(/^"|"$/g, '').toLowerCase() === 'utf-8');
}

async function readBody(request) {
  const contentLength = Number(request.headers['content-length'] || 0);
  if (contentLength > BODY_LIMIT) throw Object.assign(new Error('Payload too large'), { statusCode: 413, code: 'BODY_TOO_LARGE' });
  if (request.method === 'GET' || request.method === 'HEAD' || contentLength === 0 && !request.headers['transfer-encoding']) return undefined;
  if (request.headers['content-encoding'] && request.headers['content-encoding'] !== 'identity') {
    throw Object.assign(new Error('Unsupported content encoding'), { statusCode: 415, code: 'UNSUPPORTED_ENCODING' });
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > BODY_LIMIT) throw Object.assign(new Error('Payload too large'), { statusCode: 413, code: 'BODY_TOO_LARGE' });
    chunks.push(chunk);
  }
  if (size === 0) return undefined;
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch {
    throw Object.assign(new Error('Malformed JSON'), { statusCode: 400, code: 'INVALID_JSON' });
  }
}

function makeResponseFacade(response, redact, metricsContentType) {
  let responded = false;
  const facade = {
    get responded() { return responded; },
    status(statusCode) {
      if (!Number.isInteger(statusCode) || statusCode < 100 || statusCode > 599) throw new TypeError('invalid response status');
      response.statusCode = statusCode;
      return facade;
    },
    setHeader(name, value) {
      if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) || /[\r\n]/.test(String(value)) || name.toLowerCase() === 'set-cookie') throw new TypeError('invalid response header');
      response.setHeader(name, value);
      return facade;
    },
    json(value) {
      if (responded) return facade;
      responded = true;
      writeJson(response, response.statusCode, value, redact);
      return facade;
    },
    text(value, contentType = 'text/plain; charset=utf-8') {
      if (responded) return facade;
      const isMetricsType = /openmetrics/i.test(contentType) || /(^|;)\s*version=0\.0\.4(?:;|$)/i.test(contentType);
      if (isMetricsType && (!metricsContentType || contentType !== metricsContentType)) throw new TypeError('metrics content type is not declared by this palette');
      if (typeof value !== 'string') throw new TypeError('text response body must be a string');
      responded = true;
      response.writeHead(response.statusCode, { 'content-type': contentType });
      response.end(String(redact(value)));
      return facade;
    }
  };
  return facade;
}

function writeJson(response, statusCode, body, redact = (value) => value) {
  const payload = JSON.stringify(redact(body));
  response.writeHead(statusCode, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(payload) });
  response.end(payload);
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
    signal.addEventListener('abort', abort, { once: true });
  });
  return Promise.race([work, timeout]).finally(() => {
    clearTimeout(timer);
    signal.removeEventListener('abort', abort);
  });
}

module.exports = { createInternalServer };