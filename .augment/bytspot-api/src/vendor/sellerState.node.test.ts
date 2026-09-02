import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { VendorLocation, VendorSeat, VendorSeller } from '@prisma/client';
import { requirementsForState, effectiveCapabilities, sellerCanTransition } from './contract';
import { outstandingRequirements, satisfiedRequirements, toSeatDto, toSellerDto } from './sellerState';

const seller = (over: Partial<VendorSeller> = {}): VendorSeller =>
  ({
    id: 'sel_1',
    legalName: 'Midtown Table',
    contactEmail: 'owner@midtown.example',
    state: 'ACTIVE',
    businessMode: 'standard',
    payoutReference: 'acct_1',
    payoutStatus: 'active',
    payoutLast4: '4242',
    payoutDetail: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  }) as VendorSeller;

const location = (over: Partial<VendorLocation> = {}): VendorLocation =>
  ({
    id: 'loc_1',
    sellerId: 'sel_1',
    label: 'Main',
    kind: 'fixed',
    state: 'ACTIVE',
    address: '1 Peachtree St NE, Atlanta, GA 30303',
    lat: 33.7866,
    lng: -84.3833,
    radiusMiles: null,
    timezone: 'America/New_York',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  }) as VendorLocation;

test('a fully set-up business satisfies every requirement', () => {
  assert.deepEqual(satisfiedRequirements(seller(), [location()]), [
    'legalName',
    'contactEmail',
    'activeLocation',
    'payoutAccount',
  ]);
});

test('a pending payout account is not a payout account', () => {
  // The processor parks an account here while it decides. Counting it would let
  // a business go live and then fail to be paid.
  const met = satisfiedRequirements(seller({ payoutStatus: 'pending' }), [location()]);
  assert.ok(!met.includes('payoutAccount'));

  const restricted = satisfiedRequirements(seller({ payoutStatus: 'restricted' }), [location()]);
  assert.ok(!restricted.includes('payoutAccount'));
});

test('a place only counts while it is active, pinned and addressed', () => {
  const cases: [string, VendorLocation][] = [
    ['paused', location({ state: 'PAUSED' })],
    ['draft', location({ state: 'DRAFT' })],
    ['unaddressed', location({ address: null })],
    ['null island', location({ lat: 0, lng: 0 })],
    ['off the globe', location({ lat: 91 })],
  ];
  for (const [why, item] of cases) {
    assert.ok(
      !satisfiedRequirements(seller(), [item]).includes('activeLocation'),
      `a ${why} place must not satisfy activeLocation`,
    );
  }
});

test('a visiting provider needs no address, because it publishes none', () => {
  const visiting = location({ kind: 'visiting', address: null, radiusMiles: 10 });
  assert.ok(satisfiedRequirements(seller(), [visiting]).includes('activeLocation'));
});

test('satisfied is recomputed, so pausing the only place unsets the tick', () => {
  const live = seller();
  assert.ok(satisfiedRequirements(live, [location()]).includes('activeLocation'));
  // Same seller row, different records. A stored list would still say yes here,
  // which is the whole reason this is derived.
  assert.ok(!satisfiedRequirements(live, [location({ state: 'PAUSED' })]).includes('activeLocation'));
});

test('a live business missing a requirement is outstanding, not merely incomplete', () => {
  // Reached ACTIVE, then the place was paused. It keeps its console and is told
  // what broke rather than being dropped back into setup.
  const lapsed = outstandingRequirements(seller(), [location({ state: 'PAUSED' })]);
  assert.deepEqual(lapsed, ['activeLocation']);
});

test('a draft owes only what draft requires', () => {
  assert.deepEqual(requirementsForState('DRAFT'), []);
  assert.deepEqual(requirementsForState('PENDING'), ['legalName', 'contactEmail']);
  assert.deepEqual(requirementsForState('ACTIVE'), [
    'legalName',
    'contactEmail',
    'activeLocation',
    'payoutAccount',
  ]);
});

test('an unnamed draft still renders a heading', () => {
  const dto = toSellerDto(seller({ legalName: null, state: 'DRAFT' }), []);
  assert.equal(dto.legalName, 'Unnamed business');
  // The placeholder is display text only. It must not satisfy the requirement,
  // or a draft would tick its own name off by having none.
  assert.ok(!dto.satisfied.includes('legalName'));
  // No places, so no active location either — the rest still derive normally.
  assert.deepEqual(dto.satisfied, ['contactEmail', 'payoutAccount']);
});

test('a seat carries the user id as personId, because the client checks it', () => {
  const invitedAt = new Date('2026-09-01T10:00:00.000Z');
  const seat = toSeatDto({
    id: 'seat_1',
    sellerId: 'sel_1',
    userId: 'usr_1',
    role: 'serviceProvider',
    state: 'INVITED',
    locationIds: ['loc_1'],
    bookableIds: [],
    invitedAt,
    createdAt: new Date(),
    updatedAt: new Date(),
  } as VendorSeat);

  assert.equal(seat.personId, 'usr_1');
  assert.equal(seat.invitedAt, invitedAt.toISOString());
  // An empty list means nothing, never everything.
  assert.deepEqual(seat.bookableIds, []);
});

test('suspension withholds selling but honours what was already sold', () => {
  const suspended = effectiveCapabilities('owner', 'SUSPENDED');
  for (const kept of ['CHECK_IN', 'VERIFY', 'CANCEL', 'REFUND']) {
    assert.ok(suspended.includes(kept), `a suspended business must still ${kept}`);
  }
  for (const withheld of ['SELL', 'PUBLISH']) {
    assert.ok(!suspended.includes(withheld), `a suspended business must not ${withheld}`);
  }
});

test('a door seat cannot sell, whatever the business state', () => {
  assert.deepEqual(effectiveCapabilities('door', 'ACTIVE').sort(), ['CHECK_IN', 'VERIFY']);
});

test('closed is terminal', () => {
  assert.ok(sellerCanTransition('ACTIVE', 'SUSPENDED'));
  assert.ok(sellerCanTransition('SUSPENDED', 'ACTIVE'));
  assert.ok(!sellerCanTransition('CLOSED', 'ACTIVE'));
});
