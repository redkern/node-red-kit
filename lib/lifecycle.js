'use strict';

const { randomUUID } = require('node:crypto');
const { backoff, sleep, withTimeout, classifyError } = require('./resilience.js');

const NO_SNAPSHOT = Object.freeze({ redactValue: (value) => value, release() {} });

function createLifecycle({ signal, abort, log, status, timeoutMs = 10000, attemptCleanupMs = 5000, snapshot = () => NO_SNAPSHOT }) {
  const closers = [];
  const drains = [];
  let closing = false;
  let closePromise;
  let startState = 'idle';
  let startError;
  let startPromise;
  let activeAttempt;

  function onClose(fn, options = {}) {
    if (typeof fn !== 'function') throw new TypeError('close handler must be a function');
    if (closing) throw new Error('cannot register close handler after shutdown started');
    closers.push({ fn, force: options.force });
  }

  function onDrain(fn, options = {}) {
    if (typeof fn !== 'function') throw new TypeError('drain handler must be a function');
    if (closing) throw new Error('cannot register drain handler after shutdown started');
    drains.push({ fn, force: options.force, forced: false });
  }

  function logSafe(redactor, error, key) {
    log.error(redactor.redactValue(error), { key });
  }

  function watchLate(operation, label) {
    const operationId = randomUUID();
    operation.then(
      () => log.warn(`Late ${label} operation ${operationId} completed`, { key: 'LATE_OPERATION_COMPLETED', late: true }),
      () => log.warn(`Late ${label} operation ${operationId} failed`, { key: 'LATE_OPERATION_FAILED', late: true })
    );
  }

  function forceEntry(entry, reason, redactor = NO_SNAPSHOT) {
    if (typeof entry.force !== 'function') return false;
    try {
      entry.force();
      return true;
    } catch (error) {
      logSafe(redactor, error, error?.code || 'CLOSE_FORCE_FAILED');
      return false;
    }
  }

  async function closeStack(stack, deadline, context, redactor = NO_SNAPSHOT) {
    let safe = true;
    for (let index = stack.length - 1; index >= 0; index -= 1) {
      const entry = stack[index];
      if (Date.now() >= deadline) {
        safe = false;
        for (let remaining = index; remaining >= 0; remaining -= 1) {
          safe = forceEntry(stack[remaining], 'CLOSE_TIMEOUT', redactor) && safe;
        }
        break;
      }
      const operation = Promise.resolve().then(() => entry.fn(context));
      try {
        await withTimeout(operation, Math.max(1, deadline - Date.now()), { code: 'CLOSE_TIMEOUT' });
      } catch (error) {
        logSafe(redactor, error, error?.code || 'CLOSE_FAILED');
        safe = forceEntry(entry, error?.code, redactor) && safe;
        if (error?.code === 'CLOSE_TIMEOUT') {
          watchLate(operation, 'close');
          for (let remaining = index - 1; remaining >= 0; remaining -= 1) {
            safe = forceEntry(stack[remaining], 'CLOSE_TIMEOUT', redactor) && safe;
          }
          break;
        }
      }
    }
    return safe;
  }

  function lateResource(handler, force) {
    log.error('Resource registered after startup attempt closed', { key: 'LATE_RESOURCE_REGISTRATION' });
    if (typeof force === 'function') {
      const redactor = snapshot();
      try { force(); } catch (error) { logSafe(redactor, error, error?.code || 'CLOSE_FORCE_FAILED'); }
      redactor.release();
      return;
    }
    const redactor = snapshot();
    withTimeout(Promise.resolve().then(handler), 1000, { code: 'LATE_RESOURCE_CLEANUP_TIMEOUT' })
      .catch((error) => logSafe(redactor, error, 'LATE_RESOURCE_CLEANUP_FAILED'))
      .finally(() => redactor.release());
  }

  /** @param {(error?: Error) => void} [done] */
  function close(done = () => {}, removed = false) {
    if (closePromise) return closePromise.then(() => done(), done);
    closing = true;
    const redactor = snapshot();
    closePromise = (async () => {
      if (!signal.aborted) abort();
      const deadline = Date.now() + timeoutMs;
      for (const drain of drains) {
        if (Date.now() >= deadline) {
          if (typeof drain.force === 'function' && !drain.forced) {
            drain.forced = true;
            try { drain.force(); } catch (error) { logSafe(redactor, error, error?.code || 'CLOSE_DRAIN_FORCE_FAILED'); }
          }
          continue;
        }
        const operation = Promise.resolve().then(() => drain.fn({ deadline, signal }));
        try {
          await withTimeout(operation, Math.max(1, deadline - Date.now()), { code: 'CLOSE_DRAIN_TIMEOUT' });
        } catch (error) {
          logSafe(redactor, error, error?.code || 'CLOSE_DRAIN_FAILED');
          if (error?.code === 'CLOSE_DRAIN_TIMEOUT') watchLate(operation, 'drain');
          if (typeof drain.force === 'function' && !drain.forced) {
            drain.forced = true;
            try { drain.force(); } catch (forceError) { logSafe(redactor, forceError, forceError?.code || 'CLOSE_DRAIN_FORCE_FAILED'); }
          }
        }
      }
      if (startPromise) {
        try {
          await withTimeout(startPromise, Math.max(1, deadline - Date.now()), { code: 'CLOSE_START_TIMEOUT' });
        } catch (error) {
          logSafe(redactor, error, error?.code || 'CLOSE_START_FAILED');
        }
      }
      if (activeAttempt) {
        activeAttempt.open = false;
        await closeStack(activeAttempt.stack, deadline, { removed, deadline, signal }, redactor);
      }
      await closeStack(closers, deadline, { removed, deadline, signal }, redactor);
    })();
    return closePromise.then(() => done(), (error) => { logSafe(redactor, error, 'CLOSE_FAILED'); done(error); })
      .finally(() => redactor.release());
  }

  function onStart(fn, options = {}) {
    if (typeof fn !== 'function') throw new TypeError('onStart handler must be a function');
    if (startPromise) throw new Error('onStart may only be registered once');
    const startAlertMs = options.startAlertMs ?? 60000;
    if (!Number.isSafeInteger(startAlertMs) || startAlertMs < 1) throw new TypeError('startAlertMs must be a positive integer');
    const retryDelay = backoff({ initial: 1000, max: 30000, jitter: 'full' });
    const startedAt = Date.now();
    startState = 'starting';
    status('starting', 'starting', { phase: 'starting' });

    async function run() {
      let number = 0;
      while (!closing && !signal.aborted) {
        number += 1;
        const attemptState = { stack: [], open: true };
        const attempt = {
          number,
          signal,
          onClose(handler, closeOptions = {}) {
            if (typeof handler !== 'function') throw new TypeError('attempt close handler must be a function');
            if (!attemptState.open) return lateResource(handler, closeOptions.force);
              attemptState.stack.push({ fn: handler, force: closeOptions.force });
          }
        };
        activeAttempt = attemptState;
        const redactor = snapshot();
        try {
          await fn(attempt);
          attemptState.open = false;
          if (closing || signal.aborted) return;
          closers.push(...attemptState.stack);
          activeAttempt = undefined;
          startState = 'ready';
          status('ok', 'ready', { phase: 'ready' });
          return;
        } catch (error) {
          attemptState.open = false;
          if (closing || signal.aborted) return;
          const cleaned = await closeStack(attemptState.stack, Date.now() + attemptCleanupMs, { removed: false, deadline: Date.now() + attemptCleanupMs, signal }, redactor);
          activeAttempt = undefined;
          if (!cleaned) {
            startError = Object.assign(new Error('Startup cleanup failed'), { code: 'START_CLEANUP_FAILED', cause: redactor.redactValue(error) });
            startState = 'failed';
            status('error', 'START_CLEANUP_FAILED', { phase: 'failed' });
            logSafe(redactor, startError, startError.code);
            return;
          }

          let classification;
          try {
            classification = options.classify ? options.classify(error) : undefined;
          } catch (classifierError) {
            startError = Object.assign(new Error('Startup classifier failed'), { code: 'START_CLASSIFIER_INVALID', cause: redactor.redactValue(classifierError) });
            startState = 'failed';
            status('error', startError.code, { phase: 'failed' });
            logSafe(redactor, startError, startError.code);
            redactor.release();
            return;
          }
          if (classification !== undefined && !['config', 'auth', 'transient'].includes(classification)) {
            startError = Object.assign(new Error('Startup classifier returned an invalid class'), { code: 'START_CLASSIFIER_INVALID' });
            startState = 'failed';
            status('error', startError.code, { phase: 'failed' });
            logSafe(redactor, startError, startError.code);
            redactor.release();
            return;
          }
          const kind = classification || classifyError(error);
          if (kind === 'stop') {
            redactor.release();
            return;
          }
          startError = redactor.redactValue(error);
          const code = typeof error?.code === 'string' ? error.code : undefined;
          if (kind === 'config') {
            startState = 'failed';
            status('error', code || 'CONFIG_INVALID', { phase: 'failed' });
            logSafe(redactor, error, code || 'CONFIG_INVALID');
            redactor.release();
            return;
          }
          const alert = Date.now() - startedAt >= startAlertMs;
          status(kind === 'auth' || alert ? 'error' : 'starting', `try ${number} ${code || error?.name || 'error'}`, { phase: 'starting' });
          logSafe(redactor, error, code || 'START_FAILED');
          redactor.release();
          try { await sleep(retryDelay.next(), signal); } catch (abortError) {
            if (abortError.name !== 'AbortError') throw abortError;
          }
        } finally {
          redactor.release();
        }
      }
    }

    startPromise = Promise.resolve().then(run);
    startPromise.catch((error) => log.error(error, { key: error?.code || 'START_FAILED' }));
    return startPromise;
  }

  return {
    onClose,
    onDrain,
    close,
    onStart,
    get startState() { return startState; },
    get startError() { return startError; },
    get startPromise() { return startPromise; },
    get isClosing() { return closing; }
  };
}

module.exports = { createLifecycle };