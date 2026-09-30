import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canGrantRole, grantableRoles, inviteBlockers, inviteExpired, seatMoveRefusal, seatMoveTarget } from './team';

const known = { locationIds: ['loc_1'], bookableIds: ['win_1'] };

test('nobody hands out a seat at or above their own', () => {
  assert.deepEqual(grantableRoles('owner'), ['manager', 'staff', 'door', 'serviceProvider']);
  assert.equal(canGrantRole('manager', 'manager'), false);
  assert.equal(canGrantRole('manager', 'owner'), false);
  assert.equal(canGrantRole('manager', 'staff'), true);
  // Without SELL a seat cannot act as the business at all.
  assert.deepEqual(grantableRoles('staff'), []);
  assert.deepEqual(grantableRoles('door'), []);
});

test('an invite names a grantable role, and an assigned role arrives with work', () => {
  const base = { granter: 'owner' as const, locationIds: [], bookableIds: [], known };
  assert.deepEqual(inviteBlockers({ ...base, role: 'manager' }), []);
  assert.deepEqual(inviteBlockers({ ...base, role: 'owner' }), ['Your role cannot hand out that seat']);
  assert.deepEqual(inviteBlockers({ ...base, role: 'wizard' }), ['Your role cannot hand out that seat']);
  assert.deepEqual(inviteBlockers({ ...base, role: 'serviceProvider' }), ['Pick at least one bookable for this person']);
  assert.deepEqual(inviteBlockers({ ...base, role: 'serviceProvider', bookableIds: ['win_1'] }), []);
});

test('an assignment can only name the business\'s own places and bookables', () => {
  assert.deepEqual(
    inviteBlockers({ granter: 'owner', role: 'serviceProvider', locationIds: [], bookableIds: ['win_other'], known }),
    ['That is not one of your places or bookables'],
  );
});

test('seat moves follow the contract, and the owner seat is never removed', () => {
  const owner = { id: 'seat_owner', role: 'owner' as const };
  const staff = { id: 'seat_staff', role: 'staff' as const, state: 'ACTIVE' as const };
  assert.equal(seatMoveRefusal({ granter: owner, target: staff, operation: 'SUSPEND_SEAT' }), undefined);
  assert.equal(seatMoveTarget('SUSPEND_SEAT'), 'SUSPENDED');
  assert.equal(seatMoveRefusal({ granter: owner, target: staff, operation: 'RESTORE_SEAT' }), 'illegal-state');
  assert.equal(
    seatMoveRefusal({ granter: owner, target: { ...owner, state: 'ACTIVE' }, operation: 'REVOKE_SEAT' }),
    'self',
  );
  assert.equal(
    seatMoveRefusal({ granter: { id: 'seat_mgr', role: 'manager' }, target: { id: 'seat_owner', role: 'owner', state: 'ACTIVE' }, operation: 'REVOKE_SEAT' }),
    'unrevocable',
  );
  assert.equal(
    seatMoveRefusal({ granter: { id: 'seat_mgr', role: 'manager' }, target: { id: 'seat_m2', role: 'manager', state: 'ACTIVE' }, operation: 'SUSPEND_SEAT' }),
    'forbidden',
  );
  assert.equal(seatMoveRefusal({ granter: owner, target: staff, operation: 'INVITE_SEAT' }), 'forbidden');
});

test('an invite lapses after the contract\'s expiry, and only an invite does', () => {
  const now = new Date('2026-10-10T00:00:00Z');
  const day = 86_400_000;
  assert.equal(inviteExpired({ state: 'INVITED', invitedAt: new Date(now.getTime() - 6 * day) }, now), false);
  assert.equal(inviteExpired({ state: 'INVITED', invitedAt: new Date(now.getTime() - 8 * day) }, now), true);
  assert.equal(inviteExpired({ state: 'ACTIVE', invitedAt: new Date(now.getTime() - 30 * day) }, now), false);
});
