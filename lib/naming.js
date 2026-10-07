'use strict';

const os = require('node:os');

function names(domain) {
  if (typeof domain !== 'string' || !/^[a-z]{2,16}$/.test(domain)) {
    throw new TypeError('domain must contain 2 to 16 lowercase ASCII letters');
  }

  return Object.freeze({
    typePrefix: `redkern-${domain}-`,
    category: `redkern ${domain}`,
    routeBase: `/redkern/${domain}`,
    permRead: `redkern.${domain}.read`,
    permWrite: `redkern.${domain}.write`,
    permData: `redkern.${domain}.data`,
    envPrefix: `REDKERN_${domain.toUpperCase()}_`,
    logPrefix: `[redkern:${domain}]`,
    cssPrefix: `redkern-${domain}-`
  });
}

function instanceId() {
  return os.hostname();
}

module.exports = { names, instanceId };