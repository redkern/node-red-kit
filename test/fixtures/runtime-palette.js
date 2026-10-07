'use strict';

const kit = require('../..');

module.exports = function registerFixture(RED) {
  const rk = kit.init(RED, { domain: 'test' });

  function EchoNode(config) {
    RED.nodes.createNode(this, config);
    const k = rk.bind(this);
    const parsed = k.configure(config, { prefix: { type: 'str', default: '' } });
    k.onInput(async (msg, send) => {
      if (!parsed.ok) throw new kit.ConfigError(parsed.errors);
      msg.payload = `${parsed.value.prefix}${msg.payload}`;
      send(msg);
    }, { concurrency: 1 });
  }

  function CredentialNode(config) {
    RED.nodes.createNode(this, config);
    const k = rk.bind(this);
    const password = k.readSecret('password');
    k.log.error(`credential diagnostic ${password}`);
    k.onInput(async (msg, send) => send(msg), { concurrency: 1 });
  }

  RED.nodes.registerType('redkern-test-echo', EchoNode);
  RED.nodes.registerType('redkern-test-credential', CredentialNode, {
    credentials: { password: { type: 'password' } }
  });
};