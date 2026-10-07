'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const helper = require('node-red-node-test-helper');
const registerFixture = require('../fixtures/runtime-palette');

helper.init(require.resolve('node-red'));

test.before(async () => helper.startServer());
test.afterEach(async () => helper.unload());
test.after(async () => helper.stopServer());

test('KIT-NR-1 real runtime initializes node before bind and forwards msg', async () => {
  const flow = [
    { id: 'tab', type: 'tab', label: 'test flow' },
    { id: 'echo', type: 'redkern-test-echo', z: 'tab', x: 100, y: 100, name: 'echo', prefix: 'hello ', wires: [['capture']] },
    { id: 'capture', type: 'helper', z: 'tab', x: 300, y: 100, wires: [] }
  ];
  await helper.load(registerFixture, flow);
  const echo = helper.getNode('echo');
  const capture = helper.getNode('capture');
  assert.ok(echo);
  const received = new Promise((resolve) => capture.on('input', resolve));
  const message = { payload: 'world', marker: 1 };
  echo.receive(message);
  const output = await received;
  assert.equal(output.payload, 'hello world');
  assert.equal(output.marker, 1);
  assert.equal(output._msgid, message._msgid);
});

test('KIT-SEC-1 real runtime supplies credentials and kit redacts logs', async () => {
  const secret = 'node-red-runtime-password';
  const flow = [
    { id: 'tab', type: 'tab', label: 'credential flow' },
    { id: 'credential', type: 'redkern-test-credential', z: 'tab', x: 100, y: 100, wires: [[]] }
  ];
  await helper.load(registerFixture, flow, { credential: { password: secret } });
  const node = helper.getNode('credential');
  assert.equal(node.credentials.password, secret);
  assert.equal(node.error.called, true);
  assert.equal(node.error.getCalls().some((call) => call.args.some((value) => String(value).includes(secret))), false);
});