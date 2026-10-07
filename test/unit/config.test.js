'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseConfig, readEnv, readSettings } = require('../../lib/config');

test('parseConfig preserves zero and converts declared types', () => {
  const result = parseConfig({ count: '0', active: 'false', tags: 'a, b' }, {
    count: { type: 'int', min: 0, default: 4 },
    active: { type: 'bool', default: true },
    tags: { type: 'list' }
  });
  assert.deepEqual(result, { ok: true, value: { count: 0, active: false, tags: ['a', 'b'] } });
});

test('parseConfig returns no partial value for validation errors', () => {
  const result = parseConfig({ port: 0, host: '${REDIS_HOST}', token: '' }, {
    port: { type: 'int', min: 1 },
    host: { type: 'str' },
    token: { type: 'str', required: true }
  });
  assert.equal(result.ok, false);
  assert.equal(Object.hasOwn(result, 'value'), false);
  assert.deepEqual(result.errors.map(({ code }) => code), ['OUT_OF_RANGE', 'ENV_UNRESOLVED', 'REQUIRED']);
  assert.equal(result.errors[1].message, 'Environment variable REDIS_HOST is not set');
});

test('readEnv reads only explicitly named REDKERN variables', () => {
  const previous = process.env.REDKERN_REDIS_PORT;
  process.env.REDKERN_REDIS_PORT = '9';
  try {
    assert.equal(readEnv('REDKERN_REDIS_PORT'), '9');
    assert.throws(() => readEnv('PORT'), TypeError);
  } finally {
    if (previous === undefined) delete process.env.REDKERN_REDIS_PORT;
    else process.env.REDKERN_REDIS_PORT = previous;
  }
});

test('readSettings uses Node-RED type-prefixed camelCase keys and schema allowlist', () => {
  const RED = { settings: { redkernRedisConfigEnabled: true, redkernRedisConfigToken: 'secret', REDIS_ENABLED: false } };
  assert.deepEqual(readSettings(RED, 'redkern-redis-config', { enabled: {}, token: {} }), { enabled: true, token: 'secret' });
  assert.deepEqual(readSettings({ settings: {} }, 'redkern-redis-config', { enabled: {} }), {});
  assert.deepEqual(readSettings({ settings: null }, 'redkern-redis-config', { enabled: {} }), {});
});

test('parseConfig rejects partial numbers, non-string str values and empty list items', () => {
  for (const [config, schema] of [
    [{ count: '12abc' }, { count: { type: 'int' } }],
    [{ value: 12 }, { value: { type: 'str' } }],
    [{ tags: 'a,,b' }, { tags: { type: 'list' } }]
  ]) {
    assert.equal(parseConfig(config, schema).ok, false);
  }
});

test('parseConfig applies min/max to Unicode strings and list lengths', () => {
  assert.equal(parseConfig({ name: 'a' }, { name: { type: 'str', min: 2 } }).ok, false);
  assert.equal(parseConfig({ tags: ['a', 'b'] }, { tags: { type: 'list', max: 1 } }).ok, false);
});

test('parseConfig accepts signed numeric bounds and rejects empty required defaults', () => {
  assert.deepEqual(parseConfig({ temperature: '-2.5' }, { temperature: { type: 'float', min: -5, max: 0 } }), {
    ok: true,
    value: { temperature: -2.5 }
  });
  assert.throws(() => parseConfig({}, { token: { type: 'str', required: true, default: '' } }), TypeError);
});

test('parseConfig rejects invalid schema synchronously', () => {
  assert.throws(() => parseConfig({}, { value: { type: 'unknown' } }), TypeError);
  assert.throws(() => parseConfig({}, { value: { type: 'int', default: '1x' } }), TypeError);
});

test('ConfigError requires safe structured issues', () => {
  const { ConfigError } = require('../../lib/config');
  const error = new ConfigError([{ field: 'host', code: 'REQUIRED', message: 'host is required' }]);
  assert.equal(error.code, 'CONFIG_INVALID');
  assert.equal(error.issues[0].field, 'host');
  assert.throws(() => new ConfigError([]), TypeError);
});

test('readEnv and readSettings reject invalid names and allowlist only own settings', () => {
  assert.throws(() => readEnv('PORT'), TypeError);
  assert.throws(() => readSettings({}, 'Bad_Type', {}), TypeError);
  const result = readSettings({ settings: Object.create({ redkernRedisConfigPort: 80 }) }, 'redkern-redis-config', { port: {} });
  assert.deepEqual(result, {});
});

test('parseConfig handles optional missing values, enums, numeric booleans, and array lists', () => {
  assert.deepEqual(parseConfig({ mode: 'fast', active: 1, count: 3, tags: ['a', 'a'] }, {
    optional: { type: 'str' },
    mode: { type: 'enum', values: ['fast', 'safe'] },
    active: { type: 'bool' },
    count: { type: 'float' },
    tags: { type: 'list' }
  }), {
    ok: true,
    value: { optional: undefined, mode: 'fast', active: true, count: 3, tags: ['a', 'a'] }
  });
  assert.equal(parseConfig({ mode: 'FAST' }, { mode: { type: 'enum', values: ['fast'] } }).ok, false);
});

test('parseConfig rejects malformed enum, bounds, and defaults as schema errors', () => {
  const invalidSchemas = [
    { mode: { type: 'enum', values: [1] } },
    { count: { type: 'int', min: 2, max: 1 } },
    { count: { type: 'int', min: '1' } },
    { count: { type: 'int', default: 0, min: 1 } },
    { tags: { type: 'list', default: [''] } }
  ];
  for (const schema of invalidSchemas) assert.throws(() => parseConfig({}, schema), TypeError);
});

test('parseConfig rejects unsupported list values and invalid boolean literals', () => {
  assert.equal(parseConfig({ tags: 1 }, { tags: { type: 'list' } }).ok, false);
  assert.equal(parseConfig({ active: 'yes' }, { active: { type: 'bool' } }).ok, false);
});

test('parseConfig reports parent placeholders and unexpected conversion failures safely', () => {
  assert.deepEqual(parseConfig({ host: '${$parent.REDIS_HOST}' }, { host: { type: 'str' } }), {
    ok: false,
    errors: [{ field: 'host', code: 'ENV_UNRESOLVED', message: 'Environment variable REDIS_HOST is not set' }]
  });
  const hostileList = new Proxy([], {
    get(target, key, receiver) {
      if (key === 'some') throw new Error('conversion failed');
      return Reflect.get(target, key, receiver);
    }
  });
  assert.deepEqual(parseConfig({ tags: hostileList }, { tags: { type: 'list' } }), {
    ok: false,
    errors: [{ field: 'tags', code: 'INVALID_VALUE', message: 'conversion failed' }]
  });
});

test('parseConfig contains schema accessors that change type during conversion', () => {
  let typeReads = 0;
  const result = parseConfig({ value: 1 }, {
    value: {
      get type() {
        typeReads += 1;
        return typeReads < 3 ? 'int' : 'unsupported';
      }
    }
  });
  assert.equal(result.ok, false);
  assert.equal(result.errors[0].code, 'INVALID_VALUE');
  assert.match(result.errors[0].message, /Unsupported config type/);
});

test('parseConfig preserves whitespace strings and enforces required list bounds', () => {
  assert.deepEqual(parseConfig({ name: '   ' }, { name: { type: 'str' } }), {
    ok: true,
    value: { name: '   ' }
  });
  assert.equal(parseConfig({ tags: [] }, { tags: { type: 'list', required: true } }).errors[0].code, 'REQUIRED');
  assert.deepEqual(parseConfig({ tags: ['one'] }, { tags: { type: 'list', required: true } }), {
    ok: true,
    value: { tags: ['one'] }
  });
  assert.deepEqual(parseConfig({ count: 1 }, { count: { type: 'int', min: 1, max: 1 } }), {
    ok: true,
    value: { count: 1 }
  });
});

test('parseConfig rejects non-array enum schema values and required null defaults', () => {
  assert.throws(() => parseConfig({}, { mode: { type: 'enum', values: 'fast' } }), TypeError);
  assert.throws(() => parseConfig({}, { token: { type: 'str', required: true, default: null } }), TypeError);
  assert.throws(() => parseConfig({ token: 'value' }, { token: { type: 'str', default: null } }), /Invalid default/);
});

test('parseConfig covers safe numeric, default, and non-sized boolean bounds', () => {
  assert.equal(parseConfig({ count: Number.MAX_SAFE_INTEGER + 1 }, { count: { type: 'int' } }).errors[0].code, 'INVALID_INTEGER');
  assert.equal(parseConfig({ count: true }, { count: { type: 'int' } }).errors[0].code, 'INVALID_NUMBER');
  assert.equal(parseConfig({ ratio: Infinity }, { ratio: { type: 'float' } }).errors[0].code, 'INVALID_FLOAT');
  assert.deepEqual(parseConfig({}, { label: { type: 'str', default: '' } }), { ok: true, value: { label: '' } });
  assert.throws(() => parseConfig({}, { tags: { type: 'list', required: true, default: [] } }), /empty default/);
  assert.throws(() => parseConfig({}, { count: { type: 'int', required: true, default: '  ' } }), /empty default/);
  assert.deepEqual(parseConfig({ enabled: true }, { enabled: { type: 'bool', min: 1, max: 1 } }), {
    ok: true,
    value: { enabled: true }
  });
});