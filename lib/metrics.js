'use strict';

const { MIMEType } = require('node:util');
const { randomUUID: cryptoRandomUUID } = require('node:crypto');

function createMetricsSource(RED, { domain, contentType, metrics }) {
  if (!RED?.events || typeof RED.events.on !== 'function' || typeof RED.events.emit !== 'function') {
    throw new TypeError('RED.events must be a public event emitter');
  }
  if (typeof domain !== 'string' || !/^[a-z]{2,16}$/.test(domain)) throw new TypeError('invalid metrics domain');
  if (typeof metrics !== 'function') throw new TypeError('metrics must be a function');
  const normalizedContentType = validateContentType(contentType);
  const descriptor = Object.freeze({
    version: 1,
    sourceId: cryptoRandomUUID(),
    domain,
    contentType: normalizedContentType,
    metrics
  });
  const owners = new Set();

  function announce() {
    RED.events.emit('redkern:metrics:register', descriptor);
  }

  function discover() {
    if (owners.size > 0) announce();
  }

  function start() {
    RED.events.on('redkern:metrics:discover', discover);
    announce();
  }

  function stop() {
    RED.events.removeListener('redkern:metrics:discover', discover);
    RED.events.emit('redkern:metrics:unregister', {
      version: 1,
      sourceId: descriptor.sourceId,
      domain
    });
  }

  return {
    descriptor,
    acquire(id) {
      if (typeof id !== 'string' || id.length === 0) throw new TypeError('metrics owner id is required');
      if (owners.has(id)) throw new Error(`metrics lease already exists: ${id}`);
      owners.add(id);
      if (owners.size === 1) start();
      let active = true;
      return () => {
        if (!active) return;
        active = false;
        owners.delete(id);
        if (owners.size === 0) stop();
      };
    },
    get size() { return owners.size; }
  };
}

function validateContentType(contentType) {
  if (typeof contentType !== 'string') throw new TypeError('metrics contentType is required');
  let mediaType;
  try { mediaType = new MIMEType(contentType); } catch { throw new TypeError('invalid metrics contentType'); }
  if (mediaType.essence.toLowerCase() !== 'text/plain' || mediaType.params.get('version') !== '0.0.4') {
    throw new TypeError('metrics contentType must be Prometheus text 0.0.4');
  }
  return contentType;
}

module.exports = { createMetricsSource, validateContentType };