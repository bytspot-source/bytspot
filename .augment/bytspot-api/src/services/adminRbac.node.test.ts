import assert from 'node:assert/strict';
import { test } from 'node:test';
import { adminGroupFor, assertBytspotAdmin, ADMIN_GROUPS } from './adminRbac';

const allowlist = 'usr_ops:BYTSPOT_ADMIN,usr_oncall:INTERNAL_OPS,usr_bare';

test('allowlist maps user ids to their declared admin group', () => {
  assert.equal(adminGroupFor('usr_ops', allowlist), 'BYTSPOT_ADMIN');
  assert.equal(adminGroupFor('usr_oncall', allowlist), 'INTERNAL_OPS');
});

test('a bare allowlist entry never implicitly grants the stronger group', () => {
  assert.equal(adminGroupFor('usr_bare', allowlist), 'INTERNAL_OPS');
});

test('non-members and empty identities are refused', () => {
  assert.equal(adminGroupFor('usr_guest', allowlist), null);
  assert.equal(adminGroupFor(undefined, allowlist), null);
  assert.equal(adminGroupFor('', allowlist), null);
  // An empty allowlist must not turn into an open door.
  assert.equal(adminGroupFor('usr_ops', ''), null);
});

test('a substring of an allowlisted id is not a member', () => {
  assert.equal(adminGroupFor('usr_ops_evil', allowlist), null);
  assert.equal(adminGroupFor('xusr_ops', allowlist), null);
});

test('admin membership cannot be claimed by registering an email', () => {
  // auth.signup is public and performs no email verification, so an
  // attacker-chosen email must never resolve to a group.
  assert.equal(adminGroupFor('admin@bytspot.app', allowlist), null);
  assert.equal(
    adminGroupFor('admin@bytspot.app', 'admin@bytspot.app:BYTSPOT_ADMIN'),
    'BYTSPOT_ADMIN',
    'the parser is id-agnostic; safety comes from operators configuring ids, which the deploy check enforces',
  );
  assert.throws(
    () => assertBytspotAdmin({ userId: 'usr_attacker', email: 'admin@bytspot.app' }),
    { code: 'FORBIDDEN' },
    'an attacker who registers an admin-looking address gets no group',
  );
});

test('the gate separates unauthenticated from forbidden', () => {
  assert.throws(() => assertBytspotAdmin(null), { code: 'UNAUTHORIZED' });
  assert.throws(
    () => assertBytspotAdmin({ userId: 'usr_guest', email: 'guest@bytspot.com' }),
    { code: 'FORBIDDEN' },
  );
});

test('only the two documented groups exist', () => {
  assert.deepEqual([...ADMIN_GROUPS], ['BYTSPOT_ADMIN', 'INTERNAL_OPS']);
});
