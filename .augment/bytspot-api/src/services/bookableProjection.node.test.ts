import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  bookableId,
  coffeeToBookableSnapshot,
  controlFromCapability,
  partyToBookableSnapshot,
} from './bookableProjection';

test('control is a pure derivation of capability — book/request are vendor, details is local', () => {
  assert.equal(controlFromCapability('book'), 'vendor');
  assert.equal(controlFromCapability('request'), 'vendor');
  assert.equal(controlFromCapability('details'), 'local');
});

test('a minted BYT- id is prefixed, unique per call, and never embeds the source', () => {
  const a = bookableId('party_ticket');
  const b = bookableId('party_ticket');
  assert.match(a, /^BYT-party_ticket-/);
  assert.notEqual(a, b);
  assert.match(bookableId('coffee'), /^BYT-coffee-/);
});

test('a party snapshots at room granularity with the upstream id confined to fulfillment', () => {
  const snap = partyToBookableSnapshot({
    partyId: 'party-9', title: 'The Basement', capability: 'book', accessMode: 'paid-ticket', requiredMembershipTier: 'green',
  });
  assert.equal(snap.sourceKind, 'party_ticket');
  assert.equal(snap.capability, 'book');
  assert.equal(snap.provider, null);
  assert.equal(snap.tierName, 'The Basement');
  assert.equal(snap.priceCents, 0);
  assert.equal(snap.membershipFloor, 'green');
  assert.deepEqual(snap.fulfillment, { partyId: 'party-9', accessMode: 'paid-ticket' });
  assert.ok(!snap.id.includes('party-9'));
});

test('coffee is a hold-ask: always request, capacity one, reservation confined to fulfillment', () => {
  const snap = coffeeToBookableSnapshot({ coffeeReservationId: 'r-7', title: 'Highland Bakery' });
  assert.equal(snap.sourceKind, 'coffee');
  assert.equal(snap.capability, 'request');
  assert.equal(controlFromCapability(snap.capability), 'vendor');
  assert.equal(snap.capacity, 1);
  assert.deepEqual(snap.fulfillment, { coffeeReservationId: 'r-7' });
  assert.ok(!snap.id.includes('r-7'));
});

test('unreserved coffee uses the same canonical request snapshot without promising capacity', () => {
  const snap = coffeeToBookableSnapshot({ coffeeSpotId: 'spot-7', title: 'Highland Bakery' });
  assert.match(snap.id, /^BYT-coffee-/);
  assert.ok(!snap.id.includes('spot-7'));
  assert.equal(snap.sourceKind, 'coffee');
  assert.equal(snap.capability, 'request');
  assert.equal(snap.capacity, 0);
  assert.equal(snap.priceCents, 0);
  assert.equal(snap.membershipFloor, null);
  assert.deepEqual(snap.fulfillment, { coffeeSpotId: 'spot-7' });
  assert.notEqual(coffeeToBookableSnapshot({ coffeeSpotId: 'spot-7', title: 'Highland Bakery' }).id, snap.id);
});
