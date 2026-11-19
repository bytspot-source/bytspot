import assert from 'node:assert/strict';
import test from 'node:test';
import { letterOf, queryPlaces, queryVendors, type PlaceRow, type VendorRow } from './adminLists';

const now = new Date('2026-11-19T12:00:00Z');
const day = 24 * 60 * 60 * 1000;
const place = (id: string, name: string, over: Partial<PlaceRow> = {}): PlaceRow => ({
  id, name, address: 'Atlanta', category: 'restaurant', discoverable: true, bookingProvider: null, bookingUrl: null,
  bookingCheckedAt: null, bookingExpiresAt: null, listedAt: new Date(now.getTime() - Number(id.slice(1)) * day), controlledAt: null, ...over,
});
const rows = [
  place('p1', 'Rumi\u2019s Kitchen', { bookingProvider: 'opentable', bookingUrl: 'https://www.opentable.com/r/x', bookingCheckedAt: new Date(now.getTime() - 80 * day) }),
  place('p2', 'Ormsby\u2019s', { category: 'bar' }),
  place('p3', 'Ponce City Market', { category: 'market', address: 'Ponce de Leon Ave' }),
  place('p4', '9 Mile Station', { discoverable: false }),
  place('p5', 'Prestige Helicopters', { category: 'transport', bookingProvider: 'fareharbor', bookingUrl: 'https://fareharbor.com/embeds/book/x/', bookingCheckedAt: now }),
  place('p6', '\u00c9clair Bar', { category: 'bar', controlledAt: now }),
];
const last30 = { taps: new Map([['p1', 23], ['p5', 12], ['p6', 40], ['p2', 3]]), checkIns: new Map([['p3', 9]]) };

test('letters ignore accents and put digits and symbols under #', () => {
  assert.equal(letterOf('\u00c9clair'), 'E');
  assert.equal(letterOf('9 Mile Station'), '#');
  assert.equal(letterOf('  rumi'), 'R');
});

test('places: search, pill, booking site, status and letter narrow the list; letters follow the filters', () => {
  const ids = (input = {}) => queryPlaces(rows, last30, input, now).ids;
  assert.deepEqual(ids({ query: 'ponce de' }), ['p3'], 'searches the address too');
  assert.deepEqual(ids({ rail: 'nightlife', sort: 'az' }), ['p6', 'p2']);
  assert.deepEqual(ids({ provider: 'none', sort: 'az' }), ['p4', 'p6', 'p2', 'p3']);
  assert.deepEqual(ids({ provider: 'fareharbor' }), ['p5']);
  assert.deepEqual(ids({ status: 'hidden' }), ['p4']);
  assert.deepEqual(ids({ status: 'link_due' }), ['p1'], '80 days old is due within 14 days');
  assert.deepEqual(ids({ letter: 'P', sort: 'az' }), ['p3', 'p5']);
  assert.deepEqual(queryPlaces(rows, last30, { rail: 'nightlife' }, now).letters, ['E', 'O']);
  assert.deepEqual(queryPlaces(rows, last30, {}, now).letters, ['E', 'O', 'P', 'R', '#']);
});

test('places: sorts, pages and the needs-attention counts', () => {
  assert.deepEqual(queryPlaces(rows, last30, { sort: 'taps' }, now).ids.slice(0, 3), ['p6', 'p1', 'p5']);
  assert.deepEqual(queryPlaces(rows, last30, { sort: 'checkins' }, now).ids[0], 'p3');
  assert.deepEqual(queryPlaces(rows, last30, { sort: 'newest' }, now).ids.slice(0, 2), ['p1', 'p2']);
  const page = queryPlaces(rows, last30, { sort: 'az', offset: 2, limit: 2 }, now);
  assert.equal(page.total, 6);
  assert.deepEqual(page.ids, ['p2', 'p3'], 'A-Z: 9 Mile, \u00c9clair, then Ormsby\u2019s and Ponce');
  assert.deepEqual(queryPlaces(rows, last30, {}, now).attention, {
    linksDue: 1, hidden: 1,
    toPitch: [{ venueId: 'p1', name: 'Rumi\u2019s Kitchen', taps: 23 }, { venueId: 'p5', name: 'Prestige Helicopters', taps: 12 }],
  }, 'a Bytspot business (p6) is never in the pitch list');
});

const vendor = (sellerId: string, legalName: string, over: Partial<VendorRow> = {}): VendorRow => ({
  sellerId, legalName, contactEmail: `${sellerId}@example.test`, state: 'ACTIVE', awaitingApproval: false, pausedAt: null,
  createdAt: new Date(now.getTime() - Number(sellerId.slice(1)) * day), ownerInvitedAt: null, locations: [], ...over,
});
const vendors = [
  vendor('v1', 'Kitchen', { state: 'PENDING', awaitingApproval: true }),
  vendor('v2', 'Brash Coffee', { locations: [{ label: 'Westside', address: 'Howell Mill Rd' }] }),
  vendor('v3', 'Akwaaba', { state: 'SUSPENDED', pausedAt: now }),
  vendor('v9', 'Zest', { state: 'DRAFT', ownerInvitedAt: new Date(now.getTime() - 9 * day) }),
  vendor('v20', 'Old Draft', { state: 'DRAFT' }),
];

test('vendors: waiting first by default, search by email and place, status filters and attention', () => {
  const ids = (input = {}) => queryVendors(vendors, input, now).page.map((v) => v.sellerId);
  assert.deepEqual(ids(), ['v1', 'v2', 'v3', 'v9', 'v20']);
  assert.deepEqual(ids({ sort: 'az' }), ['v3', 'v2', 'v1', 'v20', 'v9']);
  assert.deepEqual(ids({ query: 'howell' }), ['v2']);
  assert.deepEqual(ids({ query: 'v3@example' }), ['v3']);
  assert.deepEqual(ids({ status: 'setup' }), ['v9', 'v20']);
  assert.deepEqual(ids({ status: 'invite_stale' }), ['v9']);
  assert.deepEqual(ids({ status: 'stuck' }), ['v20'], 'v9 is only 9 days old');
  assert.deepEqual(ids({ letter: 'K' }), ['v1']);
  assert.deepEqual(queryVendors(vendors, {}, now).attention, { waiting: 1, invite_stale: 1, stuck: 1, paused: 1 });
});
