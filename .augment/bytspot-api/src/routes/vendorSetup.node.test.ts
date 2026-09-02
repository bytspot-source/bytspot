import assert from 'node:assert/strict';
import { test } from 'node:test';
import type Stripe from 'stripe';
import { locationBlockers } from './vendorSetup';
import { LOCATION_DEFAULTS, locationOperation } from '../vendor/contract';
import { statusFrom, storedPayout } from '../vendor/payout';

const place = (over: Partial<Parameters<typeof locationBlockers>[0]> = {}) => ({
  label: 'Main',
  kind: 'fixed' as const,
  address: '1 Peachtree St NE, Atlanta, GA 30303',
  lat: 33.7866,
  lng: -84.3833,
  ...over,
});

test('a complete fixed place has nothing wrong with it', () => {
  assert.deepEqual(locationBlockers(place()), []);
});

test('a place guests come to needs an address', () => {
  assert.deepEqual(locationBlockers(place({ address: '   ' })), ['This kind of place needs an address']);
});

test('a visiting provider needs no address but does need a radius', () => {
  assert.deepEqual(locationBlockers(place({ kind: 'visiting', address: undefined, radiusMiles: 10 })), []);
  assert.deepEqual(locationBlockers(place({ kind: 'visiting', address: undefined, radiusMiles: 0 })), [
    'Say how far you travel',
  ]);
});

test('an absent radius falls back to the catalog default rather than failing', () => {
  assert.deepEqual(locationBlockers(place({ kind: 'visiting', address: undefined })), []);
});

test('travel is capped at the distance the catalog says', () => {
  const over = LOCATION_DEFAULTS.maxRadiusMiles + 1;
  assert.deepEqual(locationBlockers(place({ kind: 'mobile', radiusMiles: over })), [
    `We cap travel at ${LOCATION_DEFAULTS.maxRadiusMiles} miles`,
  ]);
  assert.deepEqual(locationBlockers(place({ kind: 'mobile', radiusMiles: LOCATION_DEFAULTS.maxRadiusMiles })), []);
});

test('an unpinned place is refused, however complete the rest is', () => {
  // A failed geocode that nobody checked looks exactly like this.
  assert.deepEqual(locationBlockers(place({ lat: 0, lng: 0 })), ['Pick an address so we can place the pin']);
  assert.deepEqual(locationBlockers(place({ lat: 91 })), ['That pin is not a real coordinate']);
  assert.deepEqual(locationBlockers(place({ lat: Number.NaN })), ['Pick an address so we can place the pin']);
});

test('an unknown kind is refused rather than treated as the default', () => {
  assert.deepEqual(locationBlockers(place({ kind: 'warehouse' as never })), ['That is not a kind of place']);
});

test('the transition table is what decides, and closed is terminal', () => {
  assert.deepEqual(locationOperation('ACTIVATE_LOCATION')?.from, ['DRAFT', 'PAUSED']);
  assert.deepEqual(locationOperation('PAUSE_LOCATION')?.from, ['ACTIVE']);
  // Nothing transitions out of CLOSED, because no operation lists it as a from.
  for (const id of ['ACTIVATE_LOCATION', 'PAUSE_LOCATION', 'CLOSE_LOCATION'] as const) {
    assert.ok(!locationOperation(id)?.from.includes('CLOSED'), `${id} must not resurrect a closed place`);
  }
});

const account = (over: Partial<Stripe.Account> = {}) =>
  ({ payouts_enabled: true, details_submitted: true, requirements: { currently_due: [] }, ...over }) as Stripe.Account;

test('only an enabled account with nothing outstanding is active', () => {
  assert.deepEqual(statusFrom(account()), { status: 'active' });
});

test('a finished form is not an active account', () => {
  // details_submitted is where a business goes live and then fails to be paid.
  const reviewing = statusFrom(account({ payouts_enabled: false }));
  assert.equal(reviewing.status, 'pending');
  assert.match(reviewing.detail ?? '', /reviewing/);
});

test('an outstanding requirement holds an otherwise enabled account back', () => {
  const due = statusFrom(account({ requirements: { currently_due: ['individual.id_number'] } as never }));
  assert.notEqual(due.status, 'active');
});

test('a disabled account is restricted, with the reason made readable', () => {
  const blocked = statusFrom(
    account({ payouts_enabled: false, requirements: { disabled_reason: 'requirements.past_due' } as never }),
  );
  assert.equal(blocked.status, 'restricted');
  // Processor reason codes are dot-cased identifiers; this one is shown.
  assert.equal(blocked.detail, 'Requirements past due');
});

test('a business with no processor account has no payout, not a pending one', () => {
  assert.equal(storedPayout({ payoutReference: null } as never), undefined);
});

test('an unrecognised stored status reads as pending, never as active', () => {
  const payout = storedPayout({
    payoutReference: 'acct_1',
    payoutStatus: 'something_new',
    payoutLast4: null,
    payoutDetail: null,
  } as never);
  assert.equal(payout?.status, 'pending');
});
