import assert from 'node:assert/strict';
import { test } from 'node:test';
import { adminGroupFor, assertBytspotAdmin, ADMIN_GROUPS } from './adminRbac';

const allowlist = 'ops@bytspot.com:BYTSPOT_ADMIN,oncall@bytspot.com:INTERNAL_OPS,bare@bytspot.com';

test('allowlist maps emails to their declared admin group', () => {
  assert.equal(adminGroupFor('ops@bytspot.com', allowlist), 'BYTSPOT_ADMIN');
  assert.equal(adminGroupFor('oncall@bytspot.com', allowlist), 'INTERNAL_OPS');
});

test('a bare allowlist entry never implicitly grants the stronger group', () => {
  assert.equal(adminGroupFor('bare@bytspot.com', allowlist), 'INTERNAL_OPS');
});

test('matching is case- and whitespace-insensitive', () => {
  assert.equal(adminGroupFor('  OPS@Bytspot.com ', allowlist), 'BYTSPOT_ADMIN');
});

test('non-members and empty identities are refused', () => {
  assert.equal(adminGroupFor('guest@bytspot.com', allowlist), null);
  assert.equal(adminGroupFor(undefined, allowlist), null);
  assert.equal(adminGroupFor('', allowlist), null);
  // An empty allowlist must not turn into an open door.
  assert.equal(adminGroupFor('ops@bytspot.com', ''), null);
});

test('a substring of an allowlisted address is not a member', () => {
  assert.equal(adminGroupFor('ops@bytspot.com.evil.test', allowlist), null);
  assert.equal(adminGroupFor('xops@bytspot.com', allowlist), null);
});

test('the gate separates unauthenticated from forbidden', () => {
  assert.throws(() => assertBytspotAdmin(null), { code: 'UNAUTHORIZED' });
  assert.throws(
    () => assertBytspotAdmin({ userId: 'u-1', email: 'guest@bytspot.com' }),
    { code: 'FORBIDDEN' },
  );
});

test('only the two documented groups exist', () => {
  assert.deepEqual([...ADMIN_GROUPS], ['BYTSPOT_ADMIN', 'INTERNAL_OPS']);
});
