'use strict';

const { createHmac, randomBytes, timingSafeEqual } = require('node:crypto');

function secureCompare(expected, supplied) {
  if (typeof expected !== 'string' || expected.length === 0 ||
      typeof supplied !== 'string' || supplied.length === 0) return false;
  const key = randomBytes(32);
  const expectedDigest = createHmac('sha256', key).update(expected, 'utf8').digest();
  const suppliedDigest = createHmac('sha256', key).update(supplied, 'utf8').digest();
  return timingSafeEqual(expectedDigest, suppliedDigest);
}

function extractToken(req) {
  if (!req || typeof req !== 'object' || !req.headers || typeof req.headers !== 'object') return undefined;
  const headers = req.headers;
  if (hasRepeatedRawHeader(req.rawHeaders, 'authorization') || hasRepeatedRawHeader(req.rawHeaders, 'x-api-key')) return undefined;
  const authorization = readHeader(headers, 'authorization');
  const apiKey = readHeader(headers, 'x-api-key');
  if (authorization.invalid || apiKey.invalid || (authorization.value && apiKey.value)) return undefined;

  let token;
  if (authorization.value !== undefined) {
    const match = authorization.value.match(/^Bearer ([^\s,]+)$/i);
    if (!match) return undefined;
    token = match[1];
  } else {
    token = apiKey.value;
  }
  if (typeof token !== 'string' || token.length === 0 || /[\r\n]/.test(token)) return undefined;
  if (Buffer.byteLength(token, 'utf8') > 4096) return undefined;
  return token;
}

function hasRepeatedRawHeader(rawHeaders, expectedName) {
  if (!Array.isArray(rawHeaders)) return false;
  let count = 0;
  for (let index = 0; index < rawHeaders.length; index += 2) {
    if (typeof rawHeaders[index] === 'string' && rawHeaders[index].toLowerCase() === expectedName) count += 1;
  }
  return count > 1;
}

function readHeader(headers, expectedName) {
  const matchingKeys = Object.keys(headers).filter((name) => name.toLowerCase() === expectedName);
  if (matchingKeys.length > 1) return { invalid: true };
  if (matchingKeys.length === 0) return { value: undefined, invalid: false };
  const value = headers[matchingKeys[0]];
  if (typeof value !== 'string' || value.length === 0 || value.includes(',')) return { invalid: true };
  return { value, invalid: false };
}

class PublicError extends Error {
  /** @param {{ code?: string }} [options] */
  constructor(status, message, options = {}) {
    const { code } = options;
    if (!Number.isInteger(status) || status < 400 || status > 499) throw new TypeError('PublicError status must be between 400 and 499');
    if (typeof message !== 'string' || message.length === 0) throw new TypeError('PublicError message must be a non-empty string');
    super(message);
    this.name = 'PublicError';
    this.status = status;
    if (code !== undefined) {
      if (typeof code !== 'string' || !/^[A-Z][A-Z0-9_]{0,63}$/.test(code)) throw new TypeError('PublicError code must be an uppercase identifier');
      this.code = code;
    }
  }
}

module.exports = { secureCompare, extractToken, PublicError };