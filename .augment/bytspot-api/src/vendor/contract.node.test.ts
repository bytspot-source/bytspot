import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CONTRACT_VERSIONS,
  VENDOR_CONSOLE,
  allowedBookableTypes,
  bookableTypeFor,
  roleCapabilities,
  roleScope,
  sellerCanUseConsole,
  stateAllows,
} from './contract';
import bookableTemplates from './contracts/bookable-templates.json';

const BOOKABLE_TEMPLATES_LIST = bookableTemplates.templates as { id: string; domain: string; schema: string }[];

/**
 * The contracts here are copies of the ones in bytspot-beta, because the
 * console and the API deploy separately. A copy drifts silently, so the version
 * is pinned: bumping the contract upstream fails this test rather than serving
 * a state machine the console no longer believes in.
 *
 * When this fails, re-copy both files from bytspot-beta/contracts and update
 * the numbers here in the same commit.
 */
test('the copied contracts are the versions this API was written against', () => {
  assert.equal(CONTRACT_VERSIONS.bookableTemplates, 8, 'bookable-templates.json moved; re-copy it');
  assert.equal(CONTRACT_VERSIONS.vendorConsole, 5, 'vendor-console.json moved; re-copy it');
});

test('every staff role has a scope and at least one capability', () => {
  for (const role of ['owner', 'manager', 'staff', 'door', 'serviceProvider'] as const) {
    assert.ok(roleCapabilities(role).length > 0, `${role} grants nothing`);
    assert.ok(['all', 'assigned'].includes(roleScope(role)), `${role} has no scope`);
  }
});

test('an unknown role grants nothing and is scoped to nothing', () => {
  // Fail closed: a role that arrives from a stale client must not inherit the
  // widest defaults.
  assert.deepEqual(roleCapabilities('ghost' as never), []);
  assert.equal(roleScope('ghost' as never), 'assigned');
});

test('a closed business cannot open the console', () => {
  assert.ok(sellerCanUseConsole('DRAFT'));
  assert.ok(sellerCanUseConsole('SUSPENDED'));
  assert.ok(!sellerCanUseConsole('CLOSED'));
});

test('a closed business allows nothing at all', () => {
  assert.deepEqual(stateAllows('CLOSED'), []);
});

test('only an active business may sell or publish', () => {
  assert.ok(stateAllows('ACTIVE').includes('SELL'));
  assert.ok(stateAllows('ACTIVE').includes('PUBLISH'));
  for (const state of ['DRAFT', 'PENDING', 'SUSPENDED'] as const) {
    assert.ok(!stateAllows(state).includes('SELL'), `${state} must not sell`);
  }
});

test('a business kind narrows to its own types, plus the ones it added', () => {
  assert.deepEqual(allowedBookableTypes('valet'), ['parking', 'ride']);
  assert.deepEqual(allowedBookableTypes('valet', ['stay', 'parking', 'made-up']), ['parking', 'ride', 'stay']);
  // Not asked yet, or a kind the contract no longer lists: nothing is narrowed.
  assert.equal(allowedBookableTypes(null, ['stay']), undefined);
  assert.equal(allowedBookableTypes('spaceport'), undefined);
});

test('a variant shared by two domains resolves to the right bookable type', () => {
  assert.equal(bookableTypeFor('stall', 'valet'), 'parking');
  assert.equal(bookableTypeFor('automotive', 'valet'), 'ride');
  assert.equal(bookableTypeFor('nightlife', 'guest-list'), 'ticket');
  assert.equal(bookableTypeFor('nightlife', 'vip'), 'experience');
  assert.equal(bookableTypeFor('dining', 'nope'), undefined);
});

test('every catalog preset belongs to exactly one bookable type', () => {
  const types = VENDOR_CONSOLE.bookableTypes as { id: string; domain: string; variants: string[] }[];
  for (const template of BOOKABLE_TEMPLATES_LIST) {
    const owners = types.filter((type) => type.domain === template.domain && type.variants.includes(template.schema));
    assert.equal(owners.length, 1, `${template.id} belongs to ${owners.length} bookable types`);
  }
});
