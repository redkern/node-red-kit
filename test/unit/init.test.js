'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const kit = require('../..');

function setup(env = {}) {
  const previous = {};
  for (const [key, value] of Object.entries(env)) {
    previous[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  const messages = [];
  const RED = {
    settings: {},
    events: new EventEmitter(),
    log: Object.fromEntries(['error', 'warn', 'info', 'debug'].map((level) => [level, (message) => messages.push([level, message])]))
  };
  return {
    RED,
    messages,
    restore() {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  };
}

test('init resolves domain params and the enabled switch', () => {
  const env = setup({ REDKERN_REDIS_ENABLED: 'true', REDKERN_REDIS_POOL_SIZE: '3' });
  try {
    const context = kit.init(env.RED, { domain: 'redis', params: { poolSize: { type: 'int', default: 1 } } });
    assert.equal(context.enabled, true);
    assert.deepEqual(context.config, { ok: true, value: { poolSize: 3 } });
    assert.equal(context.names.permData, 'redkern.redis.data');
  } finally { env.restore(); }
});

test('bind handles enabled input, tracks rejected work, and aborts on close', async () => {
  const env = setup({ REDKERN_REDIS_ENABLED: undefined });
  try {
    const context = kit.init(env.RED, { domain: 'redis' });
    const node = new EventEmitter();
    node.id = 'node-1';
    node.status = () => {};
    node.send = () => {};
    for (const level of ['error', 'warn', 'log', 'debug']) {
      node[level] = (message) => env.messages.push([level, message]);
    }
    const bound = context.bind(node);
    bound.onInput(async (msg, send) => {
      msg.handled = true;
      send(msg);
    }, { concurrency: 1 });
    let completed;
    const message = { payload: 'original' };
    let forwarded;
    await new Promise((resolve, reject) => {
      node.emit('input', message, (output) => { forwarded = output; }, (error) => {
        if (error) reject(error);
        else { completed = true; resolve(); }
      });
    });
    assert.equal(completed, true);
    assert.equal(forwarded, message);
    assert.equal(message.handled, true);
    assert.equal(await bound.track(Promise.reject(new Error('background failure'))), false);
    assert.equal(env.messages.some(([level]) => level === 'error'), true);
    const closed = new Promise((resolve) => node.emit('close', false, resolve));
    await closed;
    assert.equal(bound.signal.aborted, true);
  } finally { env.restore(); }
});

test('disabled nodes silently complete input and invalid settings return an error', async () => {
  for (const [setting, expectedCode] of [['false', undefined], ['off', 'PALETTE_DISABLED_INVALID']]) {
    const env = setup({ REDKERN_REDIS_ENABLED: setting });
    try {
      const node = new EventEmitter();
      node.id = 'disabled';
      node.status = () => {};
      const context = kit.init(env.RED, { domain: 'redis' });
      const bound = context.bind(node);
      assert.equal(context.enabled, false);
      assert.equal(context.disabledReason?.code, expectedCode ? 'PALETTE_DISABLED_INVALID' : undefined);
      bound.onInput(() => assert.fail('disabled input must not run'), { concurrency: 1 });
      await new Promise((resolve) => node.emit('input', {}, undefined, (error) => {
        assert.equal(error?.code, expectedCode);
        resolve();
      }));
      await new Promise((resolve) => node.emit('close', false, resolve));
    } finally { env.restore(); }
  }
});

test('plugin requires an explicit id and has no node lifecycle methods', () => {
  const env = setup();
  try {
    const context = kit.init(env.RED, { domain: 'redis' });
    assert.throws(() => context.plugin(), /plugin id is required/);
    const plugin = context.plugin({ id: 'metrics-plugin' });
    assert.equal(typeof plugin.enabled, 'boolean');
    assert.equal('settings' in plugin, false);
    assert.equal('readSettings' in plugin, false);
    assert.equal('onClose' in plugin, false);
    assert.equal('status' in plugin, false);
  } finally { env.restore(); }
});

test('runtime configuration is snapshotted at init and changes require restart', () => {
  const env = setup({ REDKERN_REDIS_POOL_SIZE: '2' });
  try {
    env.RED.settings.redkernRedisConfigPoolSize = '3';
    const context = kit.init(env.RED, {
      domain: 'redis',
      settingsType: 'redkern-redis-config',
      params: { poolSize: { type: 'int', default: 1 } }
    });
    assert.equal(context.config.value.poolSize, 2);
    process.env.REDKERN_REDIS_POOL_SIZE = '4';
    env.RED.settings.redkernRedisConfigPoolSize = '5';
    assert.equal(context.config.value.poolSize, 2);
  } finally { env.restore(); }
});

test('plugin track consumes success and rejection under its explicit logger id', async () => {
  const env = setup();
  try {
    const plugin = kit.init(env.RED, { domain: 'redis' }).plugin({ id: 'plugin-track' });
    assert.equal(await plugin.track(Promise.resolve()), true);
    assert.equal(await plugin.track(Promise.reject(new Error('background failure'))), false);
    assert.equal(env.messages.at(-1)[0], 'error');
    assert.equal(env.messages.at(-1)[1].includes('plugin-track'), true);
  } finally { env.restore(); }
});

test('bind rejects an uninitialized or already-bound node and disabled onStart is inert', async () => {
  const env = setup({ REDKERN_REDIS_ENABLED: 'false' });
  try {
    const context = kit.init(env.RED, { domain: 'redis' });
    assert.throws(() => context.bind({}), /createNode/);
    assert.throws(() => context.bind(null), /node is required/);
    const node = new EventEmitter();
    node.id = 'disabled-start';
    node.status = () => {};
    const bound = context.bind(node);
    assert.throws(() => context.bind(node), /already bound/);
    assert.equal(await bound.onStart(async () => assert.fail('disabled startup')), false);
    await new Promise((resolve) => node.emit('close', false, resolve));
  } finally { env.restore(); }
});

test('disabled node context rejects internal server acquisition', async () => {
  const env = setup({ REDKERN_REDIS_ENABLED: 'false' });
  try {
    const port = 9552;
    const context = kit.init(env.RED, {
      domain: 'redis',
      internalServer: { port, routes: [{ method: 'GET', path: '/health', auth: 'local', handler: async () => {} }] }
    });
    const node = new EventEmitter();
    node.id = 'disabled-server';
    node.status = () => {};
    const bound = context.bind(node);
    assert.throws(() => bound.internalServer.acquire('owner', {}), /disabled/);
    await new Promise((resolve) => node.emit('close', false, resolve));
  } finally { env.restore(); }
});

test('node close supports the callback-only Node-RED signature', async () => {
  const env = setup();
  try {
    const node = new EventEmitter();
    node.id = 'callback-close';
    node.status = () => {};
    const context = kit.init(env.RED, { domain: 'redis' }).bind(node);
    await new Promise((resolve, reject) => node.emit('close', (error) => error ? reject(error) : resolve()));
    assert.equal(context.signal.aborted, true);
  } finally { env.restore(); }
});

test('node close tolerates an omitted completion callback', async () => {
  const env = setup();
  try {
    const node = new EventEmitter();
    node.id = 'close-without-callback';
    node.status = () => {};
    const context = kit.init(env.RED, { domain: 'redis' }).bind(node);
    node.emit('close', false);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(context.signal.aborted, true);
  } finally { env.restore(); }
});

test('bind accepts a callable Node-RED node object', () => {
  const env = setup();
  try {
    const node = function nodeConstructor() {};
    node.id = 'callable-node';
    node.on = () => {};
    node.status = () => {};
    assert.equal(typeof kit.init(env.RED, { domain: 'redis' }).bind(node).onInput, 'function');
  } finally { env.restore(); }
});

test('settingsType and empty environment values follow env-settings-default priority', () => {
  const env = setup({ REDKERN_REDIS_ENABLED: '', REDKERN_REDIS_POOL_SIZE: '' });
  try {
    env.RED.settings.redkernRedisConfigPoolSize = '7';
    env.RED.settings.redkernRedisConfigEnabled = 'true';
    const context = kit.init(env.RED, {
      domain: 'redis',
      settingsType: 'redkern-redis-config',
      params: { poolSize: { type: 'int', default: 2 } }
    });
    assert.equal(context.enabled, true);
    assert.deepEqual(context.config, { ok: true, value: { poolSize: 7 } });
  } finally { env.restore(); }
});

test('enabled setting accepts boolean false from Node-RED settings', () => {
  const env = setup({ REDKERN_REDIS_ENABLED: '' });
  try {
    env.RED.settings.redkernRedisConfigEnabled = false;
    const context = kit.init(env.RED, { domain: 'redis', settingsType: 'redkern-redis-config' });
    assert.equal(context.enabled, false);
    assert.equal(context.disabledReason, null);
  } finally { env.restore(); }
});

test('init applies schema defaults and initializes metrics with an internal server', () => {
  const env = setup();
  try {
    env.RED.settings.redkernRedisConfigEnabled = true;
    env.RED.settings.redkernRedisConfigInternalPort = '9555';
    const context = kit.init(env.RED, {
      domain: 'redis',
      settingsType: 'redkern-redis-config',
      params: { poolSize: { type: 'int', default: 7 } },
      metrics: { contentType: 'text/plain; version=0.0.4', metrics: async () => 'up 1\n' },
      internalServer: {
        port: 9551,
        routes: [{ method: 'GET', path: '/health', auth: 'local', handler: async () => {} }]
      }
    });
    assert.equal(context.enabled, true);
    assert.deepEqual(context.config.value, { poolSize: 7, internalPort: 9555 });
  } finally { env.restore(); }
});

test('disabled palettes still validate internal server schema without reading runtime params', () => {
  const env = setup({ REDKERN_REDIS_ENABLED: 'false', REDKERN_REDIS_POOL_SIZE: 'not-an-integer' });
  try {
    const context = kit.init(env.RED, {
      domain: 'redis',
      params: { poolSize: { type: 'int', default: 1 } },
      internalServer: {
        port: 9551,
        routes: [{ method: 'GET', path: '/health', auth: 'local', handler: async () => {} }]
      }
    });
    assert.equal(context.enabled, false);
    assert.equal(context.config.ok, true);
  } finally { env.restore(); }
});

test('invalid node configure blocks input even without onStart', async () => {
  const env = setup();
  try {
    const node = new EventEmitter();
    node.id = 'bad-node-config';
    node.status = () => {};
    const bound = kit.init(env.RED, { domain: 'redis' }).bind(node);
    const config = bound.configure({ port: 'bad' }, { port: { type: 'int' } });
    assert.equal(config.ok, false);
    assert.throws(() => bound.configure({}, {}), /only be called once/);
    let called = false;
    bound.onInput(() => { called = true; }, { concurrency: 1 });
    await new Promise((resolve) => node.emit('input', {}, () => {}, (error) => {
      assert.equal(error.code, 'NODE_START_FAILED');
      resolve();
    }));
    assert.equal(called, false);
    await new Promise((resolve) => node.emit('close', false, resolve));
  } finally { env.restore(); }
});

test('required internal token is validated and never exposed in config', () => {
  const token = '0123456789abcdefghijklmnopqrstuv';
  const env = setup({ REDKERN_REDIS_DRAIN_TOKEN: token });
  try {
    const context = kit.init(env.RED, { domain: 'redis', secrets: { drain: { required: true } } });
    assert.equal(context.enabled, true);
    assert.equal(JSON.stringify(context.config).includes(token), false);
  } finally { env.restore(); }
});

test('missing required internal token disables the palette before I/O', () => {
  const env = setup({ REDKERN_REDIS_DRAIN_TOKEN: undefined });
  try {
    const context = kit.init(env.RED, { domain: 'redis', secrets: { drain: { required: true } } });
    assert.equal(context.enabled, false);
    assert.equal(context.config.ok, false);
    assert.equal(context.config.errors[0].code, 'SECRET_REQUIRED');
    assert.equal(JSON.stringify(context.config).includes('undefined'), false);
  } finally { env.restore(); }
});

test('internal token values cannot be reused across route classes', () => {
  const token = '0123456789abcdefghijklmnopqrstuv';
  const env = setup({ REDKERN_REDIS_METRICS_TOKEN: token, REDKERN_REDIS_DRAIN_TOKEN: token });
  try {
    const context = kit.init(env.RED, {
      domain: 'redis',
      secrets: { metrics: { required: true }, drain: { required: true } }
    });
    assert.equal(context.enabled, false);
    assert.equal(context.disabledReason.issues.some((issue) => issue.code === 'SECRET_REUSED'), true);
  } finally { env.restore(); }
});

test('init rejects invalid runtime arguments and reserved params, and accepts metrics source', () => {
  const env = setup();
  try {
    assert.throws(() => kit.init(null, { domain: 'redis' }), TypeError);
    assert.throws(() => kit.init(env.RED, { domain: 'x' }), TypeError);
    assert.throws(() => kit.init(env.RED, { domain: 'redis', params: { enabled: { type: 'bool' } } }), /reserved/);
    assert.throws(() => kit.init(env.RED, { domain: 'redis', params: { BadName: { type: 'str' } } }), /parameter name/);
    assert.throws(() => kit.init(env.RED, { domain: 'redis', params: { poolID: { type: 'str' } } }), /parameter name/);
    assert.throws(() => kit.init(env.RED, { domain: 'redis', secrets: { Bad: { required: true } } }), /secret schema/);
    assert.throws(() => kit.init(env.RED, { domain: 'redis', secrets: { token: { required: 'yes' } } }), /secret schema/);
    assert.throws(() => kit.init(env.RED, { domain: 'redis', internalServer: {} }), /default port/);
    assert.throws(() => kit.init(env.RED, { domain: 'redis', internalServer: { port: 9551 } }), /routes must be an array/);
    assert.throws(() => kit.init(env.RED, {
      domain: 'redis',
      enabledByDefault: false,
      internalServer: { port: 9551, routes: [{ method: 'GET', path: '/health', handler: async () => {} }] }
    }), /requires local auth or a declared token/);
    assert.throws(() => kit.init(env.RED, { domain: 'redis', settingsType: 'bad_type' }), /settingsType/);
    assert.throws(() => kit.init(env.RED, { domain: 'redis', redact: 'password' }), /redact/);
    const metrics = kit.init(env.RED, { domain: 'redis', metrics: { contentType: 'text/plain; version=0.0.4', metrics: async () => '' } });
    assert.equal(metrics.enabled, true);
  } finally { env.restore(); }
});

test('enabledByDefault false disables palette until explicit enable', () => {
  const env = setup({ REDKERN_MIGRATE_ENABLED: '1' });
  try {
    const disabled = kit.init(env.RED, { domain: 'migrate', enabledByDefault: false });
    assert.equal(disabled.enabled, true);
    env.restore();
    const defaultDisabled = kit.init(env.RED, { domain: 'migrate', enabledByDefault: false });
    assert.equal(defaultDisabled.enabled, false);
    assert.equal(defaultDisabled.disabledReason, null);
  } finally { env.restore(); }
});

test('invalid params and required tokens fail closed without exposing values', () => {
  const secret = '0123456789abcdefghijklmnopqrstuv';
  const env = setup({ REDKERN_REDIS_POOL_SIZE: 'bad', REDKERN_REDIS_DRAIN_TOKEN: 'short-secret' });
  try {
    const context = kit.init(env.RED, {
      domain: 'redis',
      params: { poolSize: { type: 'int', default: 4 } },
      secrets: { drain: { required: true } }
    });
    assert.equal(context.enabled, false);
    assert.equal(context.config.ok, false);
    assert.equal(JSON.stringify(context.disabledReason).includes('short-secret'), false);
    assert.equal(JSON.stringify(context.disabledReason).includes(secret), false);
  } finally { env.restore(); }
});

test('required palette token resolves from the private type-prefixed setting', () => {
  const token = '0123456789abcdefghijklmnopqrstuv';
  const env = setup();
  try {
    env.RED.settings.redkernRedisConfigDrainToken = token;
    const context = kit.init(env.RED, {
      domain: 'redis',
      settingsType: 'redkern-redis-config',
      secrets: { drain: { required: true } }
    });
    assert.equal(context.enabled, true);
    assert.equal(JSON.stringify(context.config).includes(token), false);
  } finally { env.restore(); }
});

test('invalid palette config disables I/O before node startup', async () => {
  const env = setup({ REDKERN_REDIS_POOL_SIZE: 'not-a-number' });
  try {
    const context = kit.init(env.RED, { domain: 'redis', params: { poolSize: { type: 'int', default: 2 } } });
    assert.equal(context.config.ok, false);
    assert.equal(context.enabled, false);
    assert.equal(context.disabledReason.code, 'PALETTE_CONFIG_INVALID');
    const node = new EventEmitter();
    node.id = 'config-invalid';
    node.status = () => {};
    const bound = context.bind(node);
    let called = false;
    bound.onInput(() => { called = true; }, { concurrency: 1 });
    await new Promise((resolve) => node.emit('input', {}, undefined, resolve));
    assert.equal(called, false);
    await new Promise((resolve) => node.emit('close', false, resolve));
  } finally { env.restore(); }
});

test('startup queue deadlines start when input arrives and expired messages never run', async () => {
  const env = setup({ REDKERN_REDIS_ENABLED: undefined });
  try {
    const node = new EventEmitter();
    node.id = 'queue-deadline';
    node.status = () => {};
    node.send = () => {};
    const bound = kit.init(env.RED, { domain: 'redis' }).bind(node);
    let releaseStart;
    const started = bound.onStart(() => new Promise((resolve) => { releaseStart = resolve; }));
    let processed = 0;
    bound.onInput(async () => { processed += 1; }, { concurrency: 1, maxQueue: 1, startQueueTimeoutMs: 20 });
    const completion = (message) => new Promise((resolve) => node.emit('input', message, () => {}, resolve));
    const first = completion({ payload: 1 });
    const second = completion({ payload: 2 });
    assert.equal((await second)?.code, 'INPUT_QUEUE_FULL');
    assert.equal((await first)?.code, 'NODE_NOT_READY');
    releaseStart();
    await started;
    assert.equal(processed, 0);
    await new Promise((resolve) => node.emit('close', false, resolve));
  } finally { env.restore(); }
});

test('startup flush rechecks an expired deadline before dispatch', async () => {
  const env = setup();
  const originalNow = Date.now;
  let clock = originalNow();
  try {
    Date.now = () => clock;
    const node = new EventEmitter();
    node.id = 'deadline-flush-race';
    node.status = () => {};
    node.send = () => {};
    const bound = kit.init(env.RED, { domain: 'redis' }).bind(node);
    let releaseStart;
    let enteredStart;
    const attemptEntered = new Promise((resolve) => { enteredStart = resolve; });
    const started = bound.onStart(() => new Promise((resolve) => {
      releaseStart = resolve;
      enteredStart();
    }));
    let processed = 0;
    bound.onInput(async () => { processed += 1; }, { concurrency: 1, startQueueTimeoutMs: 100 });
    const input = new Promise((resolve) => node.emit('input', {}, () => {}, resolve));
    await attemptEntered;
    clock += 101;
    releaseStart();
    await started;
    assert.equal((await input).code, 'NODE_NOT_READY');
    assert.equal(processed, 0);
    await new Promise((resolve) => node.emit('close', false, resolve));
  } finally {
    Date.now = originalNow;
    env.restore();
  }
});

test('errorOutput sends errors to the last output and calls native done once', async () => {
  const env = setup({ REDKERN_REDIS_ENABLED: undefined });
  try {
    const node = new EventEmitter();
    node.id = 'error-output';
    node.type = 'redkern-redis-test';
    node.name = 'test';
    node.status = () => {};
    node.send = () => {};
    const bound = kit.init(env.RED, { domain: 'redis' }).bind(node);
    bound.secret('secret-value');
    bound.onInput(async () => { throw new Error('failed with secret-value'); }, {
      concurrency: 1,
      errorOutput: true,
      outputCount: 2
    });
    const message = { payload: 'keep', marker: 1 };
    let doneCount = 0;
    let outputs;
    await new Promise((resolve, reject) => node.emit('input', message, (value) => { outputs = value; }, (error) => {
      doneCount += 1;
      if (error) reject(error);
      else resolve();
    }));
    assert.equal(doneCount, 1);
    assert.equal(outputs[0], null);
    assert.equal(outputs[1], message);
    assert.equal(message.marker, 1);
    assert.equal(message.error.message.includes('secret-value'), false);
    assert.equal(message.error.source.id, 'error-output');
    await new Promise((resolve) => node.emit('close', false, resolve));
  } finally { env.restore(); }
});

test('onInput validates its handler, concurrency, queue, startup timeout, and error outputs', async () => {
  const env = setup();
  try {
    const node = new EventEmitter();
    node.id = 'input-validation';
    node.status = () => {};
    const bound = kit.init(env.RED, { domain: 'redis' }).bind(node);
    assert.throws(() => bound.onInput(null, { concurrency: 1 }), /handler/);
    assert.throws(() => bound.onInput(() => {}, {}), /concurrency/);
    assert.throws(() => bound.onInput(() => {}, { concurrency: 1, maxQueue: -1 }), /maxQueue/);
    assert.throws(() => bound.onInput(() => {}, { concurrency: 1, errorOutput: true }), /outputCount/);
    bound.onInput(() => {}, { concurrency: 1, maxQueue: 0 });
    assert.throws(() => bound.onInput(() => {}, { concurrency: 1 }), /only be registered once/);
    await new Promise((resolve) => node.emit('close', false, resolve));
  } finally { env.restore(); }
});

test('onStart must precede input and startup inputs require a positive deadline', async () => {
  const env = setup();
  try {
    const node = new EventEmitter();
    node.id = 'registration-order';
    node.status = () => {};
    const bound = kit.init(env.RED, { domain: 'redis' }).bind(node);
    bound.onInput(() => {}, { concurrency: 1 });
    assert.throws(() => bound.configure({}, {}), /configure must be called before/);
    assert.throws(() => bound.onStart(async () => {}), /before onInput/);
    await new Promise((resolve) => node.emit('close', false, resolve));

    const secondNode = new EventEmitter();
    secondNode.id = 'missing-start-timeout';
    secondNode.status = () => {};
    const second = kit.init(env.RED, { domain: 'redis' }).bind(secondNode);
    second.onStart(async () => {});
    assert.throws(() => second.onInput(() => {}, { concurrency: 1, startQueueTimeoutMs: 0 }), /positive startQueueTimeoutMs/);
    await new Promise((resolve) => secondNode.emit('close', false, resolve));
  } finally { env.restore(); }
});

test('running limiter overflow uses INPUT_QUEUE_FULL and fallback node.send', async () => {
  const env = setup();
  try {
    const node = new EventEmitter();
    node.id = 'input-overflow';
    node.status = () => {};
    const sent = [];
    node.send = (message) => sent.push(message);
    const bound = kit.init(env.RED, { domain: 'redis' }).bind(node);
    let release;
    bound.onInput(async (msg, send) => {
      await new Promise((resolve) => { release = resolve; });
      send(msg);
    }, { concurrency: 1, maxQueue: 0 });
    const first = new Promise((resolve) => node.emit('input', { payload: 1 }, undefined, resolve));
    const second = new Promise((resolve) => node.emit('input', { payload: 2 }, undefined, resolve));
    assert.equal((await second).code, 'INPUT_QUEUE_FULL');
    release();
    assert.equal(await first, undefined);
    assert.deepEqual(sent, [{ payload: 1 }]);
    await new Promise((resolve) => node.emit('close', false, resolve));
  } finally { env.restore(); }
});

test('send after handler completion is ignored and diagnosed', async () => {
  const env = setup();
  try {
    const node = new EventEmitter();
    node.id = 'late-send';
    node.status = () => {};
    node.send = () => {};
    for (const level of ['error', 'warn', 'log', 'debug']) node[level] = (message) => env.messages.push([level, message]);
    const bound = kit.init(env.RED, { domain: 'redis' }).bind(node);
    let delayedSend;
    bound.onInput(async (msg, send) => { delayedSend = send; }, { concurrency: 1 });
    await new Promise((resolve) => node.emit('input', {}, () => assert.fail('late send must not forward'), resolve));
    delayedSend({ payload: 'late' });
    assert.equal(env.messages.some(([level, message]) => level === 'warn' && message.includes('send ignored')), true);
    await new Promise((resolve) => node.emit('close', false, resolve));
  } finally { env.restore(); }
});

test('node close drains active input before resource cleanup', async () => {
  const env = setup();
  try {
    const node = new EventEmitter();
    node.id = 'input-drain';
    node.status = () => {};
    node.send = () => {};
    const bound = kit.init(env.RED, { domain: 'redis' }).bind(node);
    const order = [];
    let releaseHandler;
    bound.onInput(async () => {
      await new Promise((resolve) => { releaseHandler = resolve; });
      order.push('input-settled');
    }, { concurrency: 1 });
    bound.onClose(() => { order.push('resource-close'); });
    const inputDone = new Promise((resolve) => node.emit('input', {}, () => {}, resolve));
    await new Promise((resolve) => setImmediate(resolve));
    let closed = false;
    const closing = new Promise((resolve) => node.emit('close', false, () => { closed = true; resolve(); }));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(closed, false);
    releaseHandler();
    await inputDone;
    await closing;
    assert.deepEqual(order, ['input-settled', 'resource-close']);
  } finally { env.restore(); }
});

test('onStart retries transient failures and input waits for readiness', async () => {
  const env = setup({ REDKERN_REDIS_ENABLED: undefined });
  try {
    const node = new EventEmitter();
    node.id = 'starting';
    node.status = () => {};
    const bound = kit.init(env.RED, { domain: 'redis' }).bind(node);
    let attempts = 0;
    const started = bound.onStart(async () => {
      attempts += 1;
      if (attempts === 1) throw Object.assign(new Error('temporary'), { code: 'ECONNREFUSED' });
    }, { initial: 0, max: 0 });
    bound.onInput(async (msg) => { msg.ready = true; }, { concurrency: 1, startQueueTimeoutMs: 100 });
    await started;
    await new Promise((resolve, reject) => node.emit('input', {}, undefined, (error) => error ? reject(error) : resolve()));
    assert.equal(attempts, 2);
    await new Promise((resolve) => node.emit('close', false, resolve));
  } finally { env.restore(); }
});

test('onStart stops retrying classified config errors and requires bounded input waiting', async () => {
  const env = setup({ REDKERN_REDIS_ENABLED: undefined });
  try {
    const node = new EventEmitter();
    node.id = 'bad-config';
    node.status = () => {};
    const bound = kit.init(env.RED, { domain: 'redis' }).bind(node);
    let attempts = 0;
    await bound.onStart(async () => {
      attempts += 1;
      throw Object.assign(new Error('invalid'), { name: 'ConfigError' });
    });
    assert.equal(attempts, 1);
    assert.throws(() => bound.onInput(() => {}, { concurrency: 1 }), /startQueueTimeoutMs/);
    await new Promise((resolve) => node.emit('close', false, resolve));
  } finally { env.restore(); }
});

test('close handlers run in LIFO order', async () => {
  const env = setup({ REDKERN_REDIS_ENABLED: undefined });
  try {
    const node = new EventEmitter();
    node.id = 'lifo';
    node.status = () => {};
    const bound = kit.init(env.RED, { domain: 'redis' }).bind(node);
    const order = [];
    bound.onClose(() => order.push('first'));
    bound.onClose(() => order.push('second'));
    await new Promise((resolve) => node.emit('close', false, resolve));
    assert.deepEqual(order, ['second', 'first']);
  } finally { env.restore(); }
});

test('failed close calls force and continues with older resources', async () => {
  const env = setup({ REDKERN_REDIS_ENABLED: undefined });
  try {
    const node = new EventEmitter();
    node.id = 'force';
    node.status = () => {};
    const bound = kit.init(env.RED, { domain: 'redis' }).bind(node);
    const events = [];
    bound.onClose(() => events.push('older'));
    bound.onClose(async () => { throw new Error('close failed'); }, { force: () => events.push('forced') });
    await new Promise((resolve) => node.emit('close', true, resolve));
    assert.deepEqual(events, ['forced', 'older']);
  } finally { env.restore(); }
});

test('closing during startup aborts the attempt and releases its resources', async () => {
  const env = setup({ REDKERN_REDIS_ENABLED: undefined });
  try {
    const node = new EventEmitter();
    node.id = 'redeploy';
    node.status = () => {};
    const bound = kit.init(env.RED, { domain: 'redis' }).bind(node);
    let released = false;
    let entered;
    const attemptEntered = new Promise((resolve) => { entered = resolve; });
    const started = bound.onStart(async (attempt) => {
      attempt.onClose(() => { released = true; });
      entered();
      await new Promise((resolve) => bound.signal.addEventListener('abort', resolve, { once: true }));
    });
    await attemptEntered;
    await new Promise((resolve) => node.emit('close', false, resolve));
    await started;
    assert.equal(bound.signal.aborted, true);
    assert.equal(released, true);
  } finally { env.restore(); }
});