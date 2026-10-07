'use strict';

const STATES = Object.freeze({
  ok: Object.freeze(['green', 'dot']),
  warn: Object.freeze(['yellow', 'ring']),
  error: Object.freeze(['red', 'ring']),
  idle: Object.freeze(['grey', 'ring']),
  paused: Object.freeze(['blue', 'ring']),
  starting: Object.freeze(['yellow', 'ring']),
  disabled: Object.freeze(['grey', 'dot'])
});
const STATUS_PRIORITY = Object.freeze({ idle: 0, ok: 0, starting: 1, disabled: 2, paused: 2, warn: 3, error: 4 });

/**
 * @param {{ RED: any, node?: any, prefix: string, id?: string, redact?: (value: unknown) => unknown, maxKeys?: number, intervalMs?: number }} options
 */
function createLogger({ RED, node, prefix, id, redact = (value) => String(value), maxKeys = 256, intervalMs = 10000 }) {
  const recent = new Map();
  let disposed = false;

  function output(level, line) {
    if (node) {
      const method = level === 'info' ? node.log : node[level];
      if (typeof method === 'function') method.call(node, line);
    } else if (typeof RED.log?.[level] === 'function') {
      RED.log[level](line);
    }
  }

  function render(value) {
    const safe = redact(value);
    if (safe !== null && typeof safe === 'object' && safe instanceof Error) return `${safe.name}: ${safe.message}`;
    if (typeof safe === 'string') return safe;
    try { return JSON.stringify(safe); } catch { return '[Unserializable log value]'; }
  }

  function summary(level, line, count) {
    if (count) output(level, `${line} (suppressed ${count})`);
  }

  function write(level, message, options = {}) {
    if (disposed) return;
    const error = message instanceof Error ? message : null;
    const text = render(message);
    const candidateKey = options.key || /** @type {Error & { code?: string } | null} */ (error)?.code;
    const code = typeof candidateKey === 'string' && candidateKey.length > 0 ? `${level}:${candidateKey}` : undefined;
    const correlation = options.correlationId ? ` [${render(options.correlationId)}]` : '';
    const line = `${prefix} [${id || 'plugin'}]${correlation} ${text}`;
    if (code) {
      const now = Date.now();
      const previous = recent.get(code);
      if (previous && now - previous.time < intervalMs) {
        previous.count += 1;
        if (!previous.timer) {
          previous.timer = setTimeout(() => {
            previous.timer = undefined;
            summary(previous.level, previous.line, previous.count);
            previous.count = 0;
            previous.time = Date.now();
          }, Math.max(1, intervalMs - (now - previous.time)));
          previous.timer.unref?.();
        }
        recent.delete(code);
        recent.set(code, previous);
        return;
      }
      if (previous?.timer) clearTimeout(previous.timer);
      if (previous?.count) summary(previous.level, previous.line, previous.count);
      recent.delete(code);
      recent.set(code, { time: now, count: 0, level, line, timer: undefined });
      if (recent.size > maxKeys) {
        const oldestKey = recent.keys().next().value;
        const oldest = recent.get(oldestKey);
        if (oldest.timer) clearTimeout(oldest.timer);
        summary(oldest.level, oldest.line, oldest.count);
        recent.delete(oldestKey);
      }
    }
    output(level, line);
  }

  const logger = {
    error: (message, options) => write('error', message, options),
    warn: (message, options) => write('warn', message, options),
    info: (message, options) => write('info', message, options),
    debug: (message, options) => write('debug', message, options),
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const entry of recent.values()) {
        if (entry.timer) clearTimeout(entry.timer);
        summary(entry.level, entry.line, entry.count);
      }
      recent.clear();
    }
  };
  return logger;
}

function createStatus(node, { minIntervalMs = 250, onTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  let timer;
  let pending;
  let base;
  let lastUpdate = -Infinity;
  let disposed = false;
  const overlays = new Map();

  function visible() {
    let selected;
    for (const overlay of overlays.values()) {
      if (!selected || overlay.priority >= selected.priority) selected = overlay;
    }
    return selected?.value ?? base ?? null;
  }

  function apply(value) {
    if (value === null) node.status({});
    else {
      const [state, text] = value;
      const [fill, shape] = STATES[state];
      node.status({ fill, shape, text: Array.from(String(text || state)).slice(0, 19).join('') });
    }
    lastUpdate = Date.now();
  }

  function schedule() {
    pending = visible();
    const wait = Math.max(0, minIntervalMs - (Date.now() - lastUpdate));
    if (!wait) {
      if (timer) clearTimer(timer);
      timer = undefined;
      const next = pending;
      pending = undefined;
      apply(next);
      return;
    }
    if (!timer) {
      timer = onTimer(() => {
        timer = undefined;
        if (pending !== undefined) {
          const next = pending;
          pending = undefined;
          apply(next);
        }
      }, wait);
      timer.unref?.();
    }
  }

  function status(state, text) {
    if (disposed) return;
    if (!STATES[state]) throw new TypeError(`Unknown status state: ${state}`);
    base = [state, text];
    schedule();
  }

  status.setOverlay = (key, state, text) => {
    if (disposed) return;
    if (typeof key !== 'string' || key.length === 0) throw new TypeError('status overlay key is required');
    if (!STATES[state]) throw new TypeError(`Unknown status state: ${state}`);
    overlays.set(key, { value: [state, text], priority: STATUS_PRIORITY[state] });
    schedule();
  };
  status.clearOverlay = (key) => {
    if (disposed || !overlays.delete(key)) return;
    schedule();
  };
  status.dispose = () => {
    disposed = true;
    if (timer) clearTimer(timer);
    timer = undefined;
    pending = undefined;
    overlays.clear();
  };
  return status;
}

module.exports = { createLogger, createStatus, STATES };