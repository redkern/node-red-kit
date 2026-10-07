'use strict';

const { backoff, sleep, withTimeout, classifyError } = require('./resilience.js');

function createLifecycle({ signal, abort, log, status, timeoutMs = 10000, attemptCleanupMs = 5000 }) {
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

  function forceEntry(entry, reason) {
    if (typeof entry.force !== 'function') return false;
    try {
      entry.force();
      return true;
    } catch (error) {
      log.error(error, { key: error.code || 'CLOSE_FORCE_FAILED' });
      return false;
    }
  }

  async function closeStack(stack, deadline, context) {
    let safe = true;
    for (let index = stack.length - 1; index >= 0; index -= 1) {
      const entry = stack[index];
      if (Date.now() >= deadline) {
        safe = false;
        for (let remaining = index; remaining >= 0; remaining -= 1) {
          safe = forceEntry(stack[remaining], 'CLOSE_TIMEOUT') && safe;
        }
        break;
      }
      try {
        await withTimeout(Promise.resolve().then(() => entry.fn(context)), Math.max(1, deadline - Date.now()), { code: 'CLOSE_TIMEOUT' });
      } catch (error) {
        log.error(error, { key: error.code || 'CLOSE_FAILED' });
        safe = forceEntry(entry, error.code) && safe;
        if (error.code === 'CLOSE_TIMEOUT') {
          for (let remaining = index - 1; remaining >= 0; remaining -= 1) {
            safe = forceEntry(stack[remaining], 'CLOSE_TIMEOUT') && safe;
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
      try { force(); } catch (error) { log.error(error, { key: error.code || 'CLOSE_FORCE_FAILED' }); }
      return;
    }
    withTimeout(Promise.resolve().then(handler), 1000, { code: 'LATE_RESOURCE_CLEANUP_TIMEOUT' })
      .catch((error) => log.error(error, { key: 'LATE_RESOURCE_CLEANUP_FAILED' }));
  }

  /** @param {(error?: Error) => void} [done] */
  function close(done = () => {}, removed = false) {
    if (closePromise) return closePromise.then(() => done(), done);
    closing = true;
    closePromise = (async () => {
      if (!signal.aborted) abort();
      const deadline = Date.now() + timeoutMs;
      for (const drain of drains) {
        if (Date.now() >= deadline) {
          if (typeof drain.force === 'function' && !drain.forced) {
            drain.forced = true;
            try { drain.force(); } catch (error) { log.error(error, { key: error.code || 'CLOSE_DRAIN_FORCE_FAILED' }); }
          }
          continue;
        }
        try {
          await withTimeout(Promise.resolve().then(() => drain.fn({ deadline, signal })), Math.max(1, deadline - Date.now()), { code: 'CLOSE_DRAIN_TIMEOUT' });
        } catch (error) {
          log.error(error, { key: error.code || 'CLOSE_DRAIN_FAILED' });
          if (typeof drain.force === 'function' && !drain.forced) {
            drain.forced = true;
            try { drain.force(); } catch (forceError) { log.error(forceError, { key: forceError.code || 'CLOSE_DRAIN_FORCE_FAILED' }); }
          }
        }
      }
      if (startPromise) {
        try {
          await withTimeout(startPromise, Math.max(1, deadline - Date.now()), { code: 'CLOSE_START_TIMEOUT' });
        } catch (error) {
          log.error(error, { key: error.code || 'CLOSE_START_FAILED' });
        }
      }
      if (activeAttempt) {
        activeAttempt.open = false;
        await closeStack(activeAttempt.stack, deadline, { removed, deadline, signal });
      }
      await closeStack(closers, deadline, { removed, deadline, signal });
    })();
    return closePromise.then(() => done(), (error) => { log.error(error); done(error); });
  }

  function onStart(fn, options = {}) {
    if (typeof fn !== 'function') throw new TypeError('onStart handler must be a function');
    if (startPromise) throw new Error('onStart may only be registered once');
    const startAlertMs = options.startAlertMs ?? 60000;
    if (!Number.isSafeInteger(startAlertMs) || startAlertMs < 1) throw new TypeError('startAlertMs must be a positive integer');
    const retryDelay = backoff({ initial: 1000, max: 30000, jitter: 'full' });
    const startedAt = Date.now();
    startState = 'starting';
    status('starting', 'starting');

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
        try {
          await fn(attempt);
          attemptState.open = false;
          if (closing || signal.aborted) return;
          closers.push(...attemptState.stack);
          activeAttempt = undefined;
          startState = 'ready';
          status('ok', 'ready');
          return;
        } catch (error) {
          attemptState.open = false;
          if (closing || signal.aborted) return;
          const cleaned = await closeStack(attemptState.stack, Date.now() + attemptCleanupMs, { removed: false, deadline: Date.now() + attemptCleanupMs, signal });
          activeAttempt = undefined;
          if (!cleaned) {
            startError = Object.assign(new Error('Startup cleanup failed'), { code: 'START_CLEANUP_FAILED', cause: error });
            startState = 'failed';
            status('error', 'START_CLEANUP_FAILED');
            log.error(startError, { key: startError.code });
            return;
          }

          let classification;
          try {
            classification = options.classify ? options.classify(error) : undefined;
          } catch (classifierError) {
            startError = Object.assign(new Error('Startup classifier failed'), { code: 'START_CLASSIFIER_INVALID', cause: classifierError });
            startState = 'failed';
            status('error', startError.code);
            log.error(startError, { key: startError.code });
            return;
          }
          if (classification !== undefined && !['config', 'auth', 'transient'].includes(classification)) {
            startError = Object.assign(new Error('Startup classifier returned an invalid class'), { code: 'START_CLASSIFIER_INVALID' });
            startState = 'failed';
            status('error', startError.code);
            log.error(startError, { key: startError.code });
            return;
          }
          const kind = classification || classifyError(error);
          if (kind === 'abort') return;
          startError = error;
          if (kind === 'config') {
            startState = 'failed';
            status('error', error.code || 'CONFIG_INVALID');
            log.error(error, { key: error.code || 'CONFIG_INVALID' });
            return;
          }
          const alert = Date.now() - startedAt >= startAlertMs;
          status(kind === 'auth' || alert ? 'error' : 'starting', `try ${number} ${error.code || error.name}`);
          log.error(error, { key: error.code || 'START_FAILED' });
          try { await sleep(retryDelay.next(), signal); } catch (abortError) {
            if (abortError.name !== 'AbortError') throw abortError;
          }
        }
      }
    }

    startPromise = Promise.resolve().then(run);
    startPromise.catch((error) => log.error(error, { key: error.code || 'START_FAILED' }));
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