'use strict';

function backoff({ initial, max, multiplier = 2, jitter = 'full' }) {
  if (!Number.isFinite(initial) || !Number.isFinite(max) || !Number.isFinite(multiplier) ||
      initial < 0 || max < initial || multiplier < 1 || max > 2147483647) {
    throw new TypeError('invalid backoff bounds');
  }
    if (jitter !== 'full' && jitter !== 'equal' && !(typeof jitter === 'number' && Number.isFinite(jitter) && jitter >= 0 && jitter <= 1)) {
      throw new TypeError('jitter must be full, equal, or a fraction from 0 to 1');
    }
  let attempt = 0;
  return {
    next() {
      const ceiling = Math.min(max, initial * multiplier ** attempt++);
      let delay;
      if (jitter === 'full') delay = Math.random() * ceiling;
      else if (jitter === 'equal') delay = ceiling / 2 + Math.random() * ceiling / 2;
      else if (typeof jitter === 'number' && Number.isFinite(jitter) && jitter >= 0 && jitter <= 1) {
        delay = ceiling * (1 - jitter + Math.random() * jitter * 2);
      }
      return Math.min(max, Math.floor(delay));
    },
    reset() {
      attempt = 0;
    }
  };
}

function abortError() {
  /** @type {Error & { code?: string }} */
  const error = new Error('The operation was aborted');
  error.name = 'AbortError';
  error.code = 'ABORT_ERR';
  return error;
}

function sleep(ms, signal) {
  if (signal?.aborted) return Promise.reject(abortError());
    if (!Number.isFinite(ms) || ms < 0 || ms > 2147483647) return Promise.reject(new TypeError('ms must be a finite timer delay'));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, ms);
    function done() {
      signal?.removeEventListener('abort', aborted);
      resolve();
    }
    function aborted() {
      clearTimeout(timer);
      signal.removeEventListener('abort', aborted);
      reject(abortError());
    }
    signal?.addEventListener('abort', aborted, { once: true });
  });
}

/**
 * @param {(context: { attempt: number, signal?: AbortSignal }) => unknown | Promise<unknown>} fn
 * @param {{ attempts: number, backoff: { next(): number }, signal?: AbortSignal, retryOn?: (error: Error) => boolean }} options
 */
async function retry(fn, { attempts, backoff: delay, signal, retryOn = () => false }) {
  if (!Number.isSafeInteger(attempts) || attempts < 1) throw new TypeError('attempts must be a positive integer');
  if (typeof fn !== 'function' || typeof delay?.next !== 'function' || typeof retryOn !== 'function') {
    throw new TypeError('retry requires a function, backoff, and retryOn function');
  }
  async function runAttempt(index) {
    if (signal?.aborted) throw abortError();
    try {
      return await fn({ attempt: index + 1, signal });
    } catch (error) {
      if (error.name === 'AbortError' || index === attempts - 1 || !retryOn(error)) throw error;
      await sleep(delay.next(), signal);
      return runAttempt(index + 1);
    }
  }
  return runAttempt(0);
}

/** @param {{ signal?: AbortSignal, code?: string }} [options] */
function withTimeout(promise, ms, options = {}) {
    if (!Number.isFinite(ms) || ms < 0 || ms > 2147483647) throw new TypeError('ms must be a finite timer delay');
  const { signal, code = 'OPERATION_TIMEOUT' } = options;
  let timer;
  let onAbort;
  const operation = Promise.resolve(promise);
  operation.catch(() => {});
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error('Operation timed out'), { code })), ms);
    if (signal) {
      onAbort = () => reject(abortError());
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
  });
  return Promise.race([operation, timeout]).finally(() => {
    clearTimeout(timer);
    if (onAbort) signal.removeEventListener('abort', onAbort);
  });
}

function createLimiter({ concurrency, maxQueue }) {
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new TypeError('concurrency must be a positive integer');
  if (!Number.isInteger(maxQueue) || maxQueue < 0) throw new TypeError('maxQueue must be a non-negative integer');
  let active = 0;
  let closed = false;
  const queue = [];

  function drain() {
    while (active < concurrency && queue.length) {
      const item = queue.shift();
      item.signal?.removeEventListener('abort', item.abort);
      active += 1;
      Promise.resolve().then(() => item.task({ signal: item.signal })).then((value) => {
        active -= 1;
        drain();
        item.resolve(value);
      }, (error) => {
        active -= 1;
        drain();
        item.reject(error);
      });
    }
  }

  return {
    /** @param {(context: { signal?: AbortSignal }) => unknown | Promise<unknown>} task @param {{ signal?: AbortSignal }} [options] */
    run(task, { signal } = {}) {
      if (typeof task !== 'function') return Promise.reject(new TypeError('task must be a function'));
      if (closed) return Promise.reject(abortError());
      if (signal?.aborted) return Promise.reject(abortError());
      if (active >= concurrency && queue.length >= maxQueue) {
        return Promise.reject(Object.assign(new Error('Limiter queue is full'), { code: 'LIMITER_QUEUE_FULL' }));
      }
      return new Promise((resolve, reject) => {
        const item = { task, resolve, reject, signal };
        item.abort = () => {
          const index = queue.indexOf(item);
          if (index !== -1) {
            queue.splice(index, 1);
            reject(abortError());
          }
        };
        signal?.addEventListener('abort', item.abort, { once: true });
        queue.push(item);
        drain();
      });
    },
    get pending() {
      return queue.length;
    },
    close() {
      if (closed) return;
      closed = true;
      while (queue.length) {
        const item = queue.shift();
        item.signal?.removeEventListener('abort', item.abort);
        item.reject(abortError());
      }
    },
    stats() {
      return { active, queued: queue.length, closed };
    }
  };
}

function classifyError(error) {
  if (error?.name === 'ConfigError' || error?.code === 'CONFIG_INVALID') return 'config';
  if (error?.name === 'AbortError' || error?.code === 'ABORT_ERR') return 'abort';
  if (error?.code && /^E(?:CONN|HOST|NET|PIPE|TIMEDOUT|AI_AGAIN|NOTFOUND|REFUSED|RESET|UNREACH)/.test(error.code)) return 'transient';
  if (error?.code && /^(CERT_|ERR_TLS_|DEPTH_ZERO_SELF_SIGNED_CERT|SELF_SIGNED_CERT_IN_CHAIN)/.test(error.code)) return 'auth';
  return 'transient';
}

module.exports = { backoff, sleep, retry, withTimeout, createLimiter, classifyError };