'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createMetricsSource } = require('../../lib/metrics');
const kit = require('../..');

function mockRED() {
  const events = new EventEmitter();
  const logs = [];
  return {
    events,
    settings: {},
    log: Object.fromEntries(['error', 'warn', 'info', 'debug'].map((level) => [level, (message) => logs.push([level, message])]))
  };
}

function mockNode(id) {
  const node = new EventEmitter();
  node.id = id;
  node.type = 'redkern-prom-source';
  node.name = id;
  node.status = () => {};
  node.error = node.warn = node.log = node.debug = () => {};
  return node;
}

test('metrics source validates Prometheus text 0.0.4 media type', () => {
  const RED = mockRED();
  assert.throws(() => createMetricsSource({}, { domain: 'prom', contentType: 'text/plain; version=0.0.4', metrics: async () => '' }), /RED.events/);
  assert.throws(() => createMetricsSource({ events: { on() {} } }, { domain: 'prom', contentType: 'text/plain; version=0.0.4', metrics: async () => '' }), /RED.events/);
  assert.throws(() => createMetricsSource(RED, { domain: 'prom', contentType: 'not a media type', metrics: async () => '' }), /invalid metrics contentType/);
  assert.throws(() => createMetricsSource(RED, { domain: 'prom', metrics: async () => '' }), /metrics contentType is required/);
  assert.throws(() => createMetricsSource(RED, { domain: 'prom', contentType: 'application/openmetrics-text; version=1.0.0', metrics: async () => '' }), /Prometheus text 0.0.4/);
  assert.throws(() => createMetricsSource(RED, { domain: 'prom', contentType: 'text/plain', metrics: async () => '' }), /Prometheus text 0.0.4/);
  assert.throws(() => createMetricsSource(RED, { domain: 'prom', contentType: 'text/plain; version=0.0.4', metrics: null }), /metrics must be a function/);
  assert.throws(() => createMetricsSource(RED, { domain: 'x', contentType: 'text/plain; version=0.0.4', metrics: async () => '' }), /invalid metrics domain/);
});

test('metrics registration delegates exposition without aggregating scrapes', () => {
  const RED = mockRED();
  const events = [];
  let scrapeCalls = 0;
  const scrape = async () => { scrapeCalls += 1; return 'metric 1\n'; };
  RED.events.on('redkern:metrics:register', (event) => events.push(['register', event]));
  RED.events.on('redkern:metrics:unregister', (event) => events.push(['unregister', event]));
  const source = createMetricsSource(RED, {
    domain: 'prom',
    contentType: 'text/plain; version=0.0.4; charset=utf-8',
    metrics: scrape
  });
  RED.events.emit('redkern:metrics:discover', { version: 1 });
  assert.equal(events.length, 0);
  assert.throws(() => source.acquire(''), /owner id is required/);
  const releaseOne = source.acquire('node-1');
  const sourceId = events[0][1].sourceId;
  assert.equal(events[0][1].metrics, scrape);
  assert.equal(events[0][1].version, 1);
  assert.equal(events[0][1].domain, 'prom');
  assert.equal(events[0][1].contentType, 'text/plain; version=0.0.4; charset=utf-8');
  const releaseTwo = source.acquire('node-2');
  assert.equal(events.length, 1);
  RED.events.emit('redkern:metrics:discover', { version: 1 });
  assert.equal(events[1][1].sourceId, sourceId);
  assert.equal(scrapeCalls, 0);
  releaseOne();
  assert.equal(source.size, 1);
  releaseOne();
  assert.equal(source.size, 1);
  assert.throws(() => source.acquire('node-2'), /already exists/);
  releaseTwo();
  assert.equal(events.at(-1)[0], 'unregister');
  assert.equal(RED.events.listenerCount('redkern:metrics:discover'), 0);
  const releaseAgain = source.acquire('node-3');
  assert.equal(events.at(-1)[0], 'register');
  releaseAgain();
  assert.throws(() => source.acquire(null), /owner id is required/);
});

test('node metrics lease is optional and released automatically on close', async () => {
  const RED = mockRED();
  const rk = kit.init(RED, {
    domain: 'prom',
    metrics: { contentType: 'text/plain; version=0.0.4', metrics: async () => 'up 1\n' }
  });
  const node = mockNode('metric-node');
  const context = rk.bind(node);
  assert.equal(context.metrics !== undefined, true);
  context.metrics.acquire();
  assert.throws(() => context.metrics.acquire(), /already acquired/);
  await new Promise((resolve) => node.emit('close', false, resolve));
  assert.equal(RED.events.listenerCount('redkern:metrics:discover'), 0);

  const noMetrics = kit.init(RED, { domain: 'redis' }).bind(mockNode('no-metrics'));
  assert.equal(noMetrics.metrics, undefined);
});

test('disabled palette cannot acquire or register a metrics source', () => {
  const RED = mockRED();
  const events = [];
  RED.events.on('redkern:metrics:register', (event) => events.push(event));
  const previous = process.env.REDKERN_PROM_ENABLED;
  process.env.REDKERN_PROM_ENABLED = 'false';
  try {
    const rk = kit.init(RED, {
      domain: 'prom',
      metrics: { contentType: 'text/plain; version=0.0.4', metrics: async () => '' }
    });
    const node = mockNode('disabled-metrics');
    const context = rk.bind(node);
    assert.throws(() => context.metrics.acquire(), /disabled/);
    assert.deepEqual(events, []);
  } finally {
    if (previous === undefined) delete process.env.REDKERN_PROM_ENABLED;
    else process.env.REDKERN_PROM_ENABLED = previous;
  }
});

test('optional missing palette secret does not disable the metrics source', () => {
  const RED = mockRED();
  const context = kit.init(RED, {
    domain: 'prom',
    secrets: { scrape: { required: false } },
    metrics: { contentType: 'text/plain; version=0.0.4', metrics: async () => 'up 1\n' }
  });
  assert.equal(context.enabled, true);
});