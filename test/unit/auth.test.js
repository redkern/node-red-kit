'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const kit = require('../..');

test('secureCompare accepts equal non-empty strings and rejects invalid or unequal values', () => {
  assert.equal(kit.secureCompare('secret', 'secret'), true);
  assert.equal(kit.secureCompare('secret', 'other'), false);
  assert.equal(kit.secureCompare('', ''), false);
  assert.equal(kit.secureCompare(null, 'secret'), false);
});

test('extractToken accepts Bearer and x-api-key without query support', () => {
  assert.equal(kit.extractToken({ headers: { authorization: 'bEaReR token-value' } }), 'token-value');
  assert.equal(kit.extractToken({ headers: { 'x-api-key': 'api-token' } }), 'api-token');
  assert.equal(kit.extractToken({ headers: {}, query: { token: 'query-token' } }), undefined);
});

test('extractToken rejects ambiguous, repeated, malformed, and oversized tokens', () => {
  assert.equal(kit.extractToken({ headers: { authorization: 'Bearer token', 'x-api-key': 'other' } }), undefined);
  assert.equal(kit.extractToken({ headers: { authorization: ['Bearer one', 'Bearer two'] } }), undefined);
  assert.equal(kit.extractToken({ headers: { authorization: 'Bearer one' }, rawHeaders: ['Authorization', 'Bearer one', 'authorization', 'Bearer two'] }), undefined);
  assert.equal(kit.extractToken({ headers: { authorization: 'Bearer token,other' } }), undefined);
  assert.equal(kit.extractToken({ headers: { authorization: 'Basic token' } }), undefined);
  assert.equal(kit.extractToken({
    headers: { 'x-api-key': 'token' },
    rawHeaders: ['x-api-key', 'first', 'X-API-KEY', 'second']
  }), undefined);
  assert.equal(kit.extractToken({ headers: { authorization: `Bearer ${'x'.repeat(4097)}` } }), undefined);
  assert.equal(kit.extractToken(null), undefined);
});

test('extractToken rejects case-duplicate headers and control characters', () => {
  assert.equal(kit.extractToken({ headers: { authorization: 'Bearer first', Authorization: 'Bearer second' } }), undefined);
  assert.equal(kit.extractToken({ headers: { 'x-api-key': 'line\nbreak' } }), undefined);
  assert.equal(kit.extractToken({ headers: { 'x-api-key': 'token' }, rawHeaders: [42, 'ignored'] }), 'token');
  assert.equal(kit.extractToken({ headers: null }), undefined);
});

test('PublicError enforces 4xx status and a controlled code', () => {
  const error = new kit.PublicError(422, 'Invalid input', { code: 'INPUT_INVALID' });
  assert.equal(error.status, 422);
  assert.equal(error.code, 'INPUT_INVALID');
  assert.throws(() => new kit.PublicError(500, 'Private error'), TypeError);
  assert.throws(() => new kit.PublicError(400, ''), TypeError);
  assert.throws(() => new kit.PublicError(400, 'Bad input', { code: 'lower' }), TypeError);
});