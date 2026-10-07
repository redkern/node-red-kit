'use strict';

const naming = require('./lib/naming.js');
const config = require('./lib/config.js');
const resilience = require('./lib/resilience.js');
const { init } = require('./lib/init.js');
const { requireSecret } = require('./lib/secrets.js');
const auth = require('./lib/auth.js');
const { createRouteRegistry } = require('./lib/http.js');

module.exports = {
  ...naming,
  ...config,
  ...resilience,
  ...auth,
  PublicError: auth.PublicError,
  requireSecret,
  init
};