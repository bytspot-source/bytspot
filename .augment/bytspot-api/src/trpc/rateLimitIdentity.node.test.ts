import test from 'node:test';
import assert from 'node:assert/strict';

import type Redis from 'ioredis';

import { clientRateLimitKey } from './context';
import { incrementLocalRateLimit, incrementRedisRateLimit, rateLimitSubject, resetLocalRateLimitForTests } from './trpc';

test('A client rate-limit key is a stable HMAC that does not retain the address', () => {
  const key = clientRateLimitKey('203.0.113.42', 'test-pepper-a');
  assert.equal(key, clientRateLimitKey('203.0.113.42', 'test-pepper-a'));
  assert.notEqual(key, clientRateLimitKey('203.0.113.43', 'test-pepper-a'));
  assert.notEqual(key, clientRateLimitKey('203.0.113.42', 'test-pepper-b'));
  assert.match(key, /^[a-f0-9]{64}$/);
  assert.equal(key.includes('203.0.113.42'), false);
});

test('Public limits are per client, never one shared anonymous bucket', () => {
  assert.equal(rateLimitSubject(undefined, 'client-a'), 'client:client-a');
  assert.notEqual(rateLimitSubject(undefined, 'client-a'), rateLimitSubject(undefined, 'client-b'));
  assert.equal(rateLimitSubject('user-123', 'client-a'), 'user:user-123');
});

test('The Redis increment is one script call carrying its own TTL', async () => {
  const calls: unknown[][] = [];
  const redis: Pick<Redis, 'eval'> = { eval: (async (...args: unknown[]) => { calls.push(args); return 2; }) as Redis['eval'] };
  assert.equal(await incrementRedisRateLimit(redis, 'rate-limit:auth:google:client:test', 60_000), 2);
  assert.equal(calls.length, 1);
  assert.match(String(calls[0][0]), /INCR/);
  assert.match(String(calls[0][0]), /PEXPIRE/);
  assert.deepEqual(calls[0].slice(1), [1, 'rate-limit:auth:google:client:test', '60000']);
});

test('The local fallback rolls its window and fails closed at capacity', () => {
  resetLocalRateLimitForTests();
  assert.equal(incrementLocalRateLimit('same-client', 100, 1_000), 1);
  assert.equal(incrementLocalRateLimit('same-client', 100, 1_050), 2);
  assert.equal(incrementLocalRateLimit('same-client', 100, 1_100), 1);

  resetLocalRateLimitForTests();
  for (let index = 0; index < 10_000; index += 1) {
    assert.equal(incrementLocalRateLimit(`client-${index}`, 60_000, 0), 1);
  }
  // A full table refuses a new client rather than growing: bounded memory
  // under high-cardinality abuse is worth more than admitting the request.
  assert.equal(incrementLocalRateLimit('new-client-after-capacity', 60_000, 0), null);
  assert.equal(incrementLocalRateLimit('client-0', 60_000, 0), 2);
  resetLocalRateLimitForTests();
});
