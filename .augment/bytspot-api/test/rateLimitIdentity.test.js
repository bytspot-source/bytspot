const assert = require('node:assert/strict');
const test = require('node:test');
const { clientRateLimitKey } = require('../dist/trpc/context');
const { rateLimitSubject } = require('../dist/trpc/trpc');

test('client rate-limit keys are stable hashes and do not retain raw IP values', () => {
  const key = clientRateLimitKey('203.0.113.42');
  assert.equal(key, clientRateLimitKey('203.0.113.42'));
  assert.notEqual(key, clientRateLimitKey('203.0.113.43'));
  assert.match(key, /^[a-f0-9]{64}$/);
  assert.equal(key.includes('203.0.113.42'), false);
});

test('public auth limits are per client rather than a shared anonymous bucket', () => {
  assert.equal(rateLimitSubject(undefined, 'client-a'), 'client:client-a');
  assert.equal(rateLimitSubject(undefined, 'client-b'), 'client:client-b');
  assert.notEqual(rateLimitSubject(undefined, 'client-a'), rateLimitSubject(undefined, 'client-b'));
  assert.equal(rateLimitSubject('user-123', 'client-a'), 'user:user-123');
});
