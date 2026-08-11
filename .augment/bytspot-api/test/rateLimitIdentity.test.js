const assert = require('node:assert/strict');
const test = require('node:test');
const { clientRateLimitKey } = require('../dist/trpc/context');
const { entersPacked } = require('../dist/services/crowdTransition');
const {
  incrementLocalRateLimit,
  incrementRedisRateLimit,
  rateLimitSubject,
  resetLocalRateLimitForTests,
} = require('../dist/trpc/trpc');

test('client rate-limit keys are stable HMACs and do not retain raw IP values', () => {
  const key = clientRateLimitKey('203.0.113.42', 'test-pepper-a');
  assert.equal(key, clientRateLimitKey('203.0.113.42', 'test-pepper-a'));
  assert.notEqual(key, clientRateLimitKey('203.0.113.43', 'test-pepper-a'));
  assert.notEqual(key, clientRateLimitKey('203.0.113.42', 'test-pepper-b'));
  assert.match(key, /^[a-f0-9]{64}$/);
  assert.equal(key.includes('203.0.113.42'), false);
});

test('public auth limits are per client rather than a shared anonymous bucket', () => {
  assert.equal(rateLimitSubject(undefined, 'client-a'), 'client:client-a');
  assert.equal(rateLimitSubject(undefined, 'client-b'), 'client:client-b');
  assert.notEqual(rateLimitSubject(undefined, 'client-a'), rateLimitSubject(undefined, 'client-b'));
  assert.equal(rateLimitSubject('user-123', 'client-a'), 'user:user-123');
});

test('Redis rate-limit increment uses one script call with a TTL argument', async () => {
  const calls = [];
  const redis = {
    eval: async (...args) => {
      calls.push(args);
      return 2;
    },
  };
  assert.equal(await incrementRedisRateLimit(redis, 'rate-limit:auth:google:client:test', 60_000), 2);
  assert.equal(calls.length, 1);
  assert.match(calls[0][0], /INCR/);
  assert.match(calls[0][0], /PEXPIRE/);
  assert.deepEqual(calls[0].slice(1), [1, 'rate-limit:auth:google:client:test', '60000']);
});

test('local fallback increments an existing bucket and expires it into a new window', () => {
  resetLocalRateLimitForTests();
  assert.equal(incrementLocalRateLimit('same-client', 100, 1_000), 1);
  assert.equal(incrementLocalRateLimit('same-client', 100, 1_050), 2);
  assert.equal(incrementLocalRateLimit('same-client', 100, 1_100), 1);
  resetLocalRateLimitForTests();
});

test('local fallback fails closed when its bucket capacity is exhausted', () => {
  resetLocalRateLimitForTests();
  for (let index = 0; index < 10_000; index += 1) {
    assert.equal(incrementLocalRateLimit(`client-${index}`, 60_000, 0), 1);
  }
  assert.equal(incrementLocalRateLimit('new-client-after-capacity', 60_000, 0), null);
  assert.equal(incrementLocalRateLimit('client-0', 60_000, 0), 2);
  resetLocalRateLimitForTests();
});

test('crowd alerts fire only when a venue transitions into Packed', () => {
  assert.equal(entersPacked(3, 4), true);
  assert.equal(entersPacked(undefined, 4), true);
  assert.equal(entersPacked(4, 4), false);
  assert.equal(entersPacked(4, 3), false);
  assert.equal(entersPacked(2, 3), false);
});
