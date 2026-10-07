'use strict';

const { createLimiter } = require('./resilience.js');

function createAsync({ node, signal, log, status, enabled, lifecycle, isClosing = () => false, configIssues = () => [], sanitizeError = (error) => error }) {
  /** @param {unknown} promise @param {{ label?: string, key?: string }} [options] */
  function track(promise, { label = 'background task', key } = {}) {
    const tracked = Promise.resolve(promise);
    if (isClosing()) return tracked.then(() => false, () => false);
    return tracked.then(() => true, function handleTrackedRejection(error) {
      if (error?.name !== 'AbortError') {
        status('error', error?.code || label);
        log.error(error, { key: key || error?.code || label });
      }
      return false;
    });
  }

  function onInput(handler, options = {}) {
    if (typeof handler !== 'function') throw new TypeError('onInput handler must be a function');
    const { concurrency, errorOutput = false, outputCount } = options;
    const maxQueue = options.maxQueue === undefined ? concurrency * 100 : options.maxQueue;
    if (!Number.isSafeInteger(concurrency) || concurrency < 1) throw new TypeError('onInput requires a positive concurrency');
    if (!Number.isSafeInteger(maxQueue) || maxQueue < 0) throw new TypeError('maxQueue must be a non-negative integer');
    if (lifecycle.startPromise && (!Number.isSafeInteger(options.startQueueTimeoutMs) || options.startQueueTimeoutMs < 1)) {
      throw new TypeError('onInput with onStart requires a positive startQueueTimeoutMs');
    }
    if (errorOutput && (!Number.isSafeInteger(outputCount) || outputCount < 1)) {
      throw new TypeError('errorOutput requires outputCount of at least 1');
    }

    const limiter = createLimiter({ concurrency, maxQueue });
    const startupQueue = [];
    const runningItems = new Set();
    const activeTasks = new Set();
    let errorCount = 0;
    let inputClosed = false;

    function completeOnce(done) {
      let completed = false;
      return (error) => {
        if (completed) {
          log.warn('Input completed more than once', { key: 'INPUT_ALREADY_COMPLETED' });
          return false;
        }
        completed = true;
        if (typeof done === 'function') done(error);
        return true;
      };
    }

    function toErrorMessage(item, error) {
      const safe = sanitizeError(error);
      const message = safe instanceof Error ? safe.message : String(safe?.message || 'Operation failed');
      const code = typeof safe?.code === 'string' ? safe.code : 'INPUT_ERROR';
      const msg = item.msg && typeof item.msg === 'object' ? item.msg : { payload: item.msg };
      const errorValue = { message, code, source: { id: node.id, type: node.type, name: node.name, count: 1 } };
      if (msg.error !== undefined) errorValue.previous = sanitizeError(msg.error);
      msg.error = errorValue;
      const outputs = Array(outputCount).fill(null);
      outputs[outputCount - 1] = msg;
      item.send(outputs);
      errorCount += 1;
      status('error', `errors ${errorCount}`);
    }

    function fail(item, error, forceNative = false) {
      if (item.finished) return;
      item.finished = true;
      clearTimeout(item.timer);
      clearTimeout(item.closeTimer);
      runningItems.delete(item);
      const safeError = sanitizeError(error);
      if (errorOutput && !forceNative) {
        try {
          toErrorMessage(item, safeError);
          item.complete();
        } catch (sendError) {
          item.complete(sanitizeError(sendError));
        }
      } else {
        item.complete(safeError);
      }
    }

    function execute(item) {
      if (signal.aborted || inputClosed) {
        fail(item, Object.assign(new Error('Node is closing'), { code: 'NODE_CLOSING' }), true);
        return;
      }
      const operation = limiter.run(async () => {
        runningItems.add(item);
        if (signal.aborted || inputClosed) {
          fail(item, Object.assign(new Error('Node is closing'), { code: 'NODE_CLOSING' }), true);
          return;
        }
        let active = true;
        const guardedSend = (...args) => {
          if (!active || signal.aborted || inputClosed) {
            log.warn('Input send ignored after completion', { key: 'INPUT_ALREADY_COMPLETED' });
            return;
          }
          item.send(...args);
        };
        try {
          await handler(item.msg, guardedSend);
          active = false;
          runningItems.delete(item);
          clearTimeout(item.closeTimer);
          if (!item.finished) {
            item.finished = true;
            clearTimeout(item.timer);
            item.complete();
          }
        } catch (error) {
          active = false;
          runningItems.delete(item);
          clearTimeout(item.closeTimer);
          fail(item, error);
        }
      }, { signal }).catch((error) => {
        const mapped = error?.code === 'LIMITER_QUEUE_FULL'
          ? Object.assign(new Error('Input queue is full'), { code: 'INPUT_QUEUE_FULL' })
          : error;
        const closingError = error?.name === 'AbortError' && (signal.aborted || inputClosed)
          ? Object.assign(new Error('Node is closing'), { code: 'NODE_CLOSING' })
          : mapped;
        fail(item, closingError, error?.name === 'AbortError');
      });
      activeTasks.add(operation);
      operation.then(() => activeTasks.delete(operation), () => activeTasks.delete(operation));
    }

    function flushStartup() {
      if (lifecycle.startState === 'ready') {
        for (const item of startupQueue.splice(0)) {
          if (Date.now() >= item.startDeadline) {
            fail(item, Object.assign(new Error('Node is not ready'), { code: 'NODE_NOT_READY' }), true);
            continue;
          }
          clearTimeout(item.timer);
          execute(item);
        }
      } else if (lifecycle.startState === 'failed') {
        for (const item of startupQueue.splice(0)) {
          fail(item, Object.assign(new Error('Node startup failed'), { code: 'NODE_START_FAILED', cause: lifecycle.startError }), true);
        }
      }
    }

    if (lifecycle.startPromise) lifecycle.startPromise.then(flushStartup, flushStartup);
    signal.addEventListener('abort', () => {
      inputClosed = true;
      limiter.close();
      for (const item of startupQueue.splice(0)) fail(item, Object.assign(new Error('Node is closing'), { code: 'NODE_CLOSING' }), true);
      for (const item of runningItems) {
        item.closeTimer = setTimeout(() => fail(item, Object.assign(new Error('Node is closing'), { code: 'NODE_CLOSING' }), true), options.closeTimeoutMs || 10000);
      }
    }, { once: true });

    lifecycle.onDrain(async ({ deadline }) => {
      inputClosed = true;
      limiter.close();
      for (const item of startupQueue.splice(0)) fail(item, Object.assign(new Error('Node is closing'), { code: 'NODE_CLOSING' }), true);
      if (activeTasks.size) {
        await Promise.all([...activeTasks]);
      }
      if (Date.now() > deadline) throw Object.assign(new Error('Input drain exceeded close deadline'), { code: 'CLOSE_DRAIN_TIMEOUT' });
    }, {
      force() {
        for (const item of runningItems) fail(item, Object.assign(new Error('Node is closing'), { code: 'NODE_CLOSING' }), true);
      }
    });

    node.on('input', (msg, send, done) => {
      const complete = completeOnce(done);
      const item = {
        msg,
        send: typeof send === 'function' ? send : (...args) => node.send?.(...args),
        complete,
        timer: undefined,
        finished: false
      };
      if (inputClosed || signal.aborted) {
        fail(item, Object.assign(new Error('Node is closing'), { code: 'NODE_CLOSING' }), true);
        return;
      }
      if (!enabled()) {
        const reason = enabled.disabledReason;
        if (reason?.code === 'PALETTE_DISABLED_INVALID') {
          fail(item, Object.assign(new Error(reason.message), { code: 'PALETTE_DISABLED_INVALID' }), true);
        } else if (reason?.code === 'PALETTE_CONFIG_INVALID') {
          fail(item, Object.assign(new Error(reason.message), { code: 'PALETTE_CONFIG_INVALID' }), true);
        } else {
          item.finished = true;
          item.complete();
        }
        return;
      }
      if (configIssues().length) {
        fail(item, Object.assign(new Error('Node configuration is invalid'), { code: 'NODE_START_FAILED' }), true);
        return;
      }
      if (lifecycle.startPromise && lifecycle.startState !== 'ready') {
        if (lifecycle.startState === 'failed') {
          fail(item, Object.assign(new Error('Node startup failed'), { code: 'NODE_START_FAILED', cause: lifecycle.startError }), true);
          return;
        }
        if (startupQueue.length >= maxQueue) {
          fail(item, Object.assign(new Error('Input queue is full'), { code: 'INPUT_QUEUE_FULL' }));
          return;
        }
        item.startDeadline = Date.now() + options.startQueueTimeoutMs;
        startupQueue.push(item);
        item.timer = setTimeout(() => {
          const index = startupQueue.indexOf(item);
          if (index !== -1) startupQueue.splice(index, 1);
          fail(item, Object.assign(new Error('Node is not ready'), { code: 'NODE_NOT_READY' }), true);
        }, options.startQueueTimeoutMs);
        return;
      }
      execute(item);
    });

    return { close: () => { inputClosed = true; limiter.close(); }, stats: () => ({ ...limiter.stats(), starting: startupQueue.length, errors: errorCount }) };
  }

  return { track, onInput };
}

module.exports = { createAsync };