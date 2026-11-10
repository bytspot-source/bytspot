import assert from 'node:assert/strict';
import { test } from 'node:test';
import { db } from '../lib/db';
import { analyticsRange, loadAnalytics, localDate, payoutTotals, summarizeAnalytics, summarizeEarnings } from './insights';
import { commitmentFlags, scheduleBlockers, slotOperationAllowed } from './slots';

test('analytics counts what the demand rail recorded and ranks what sold', () => {
  const summary = summarizeAnalytics({
    days: 30,
    events: [
      { kind: 'BROADCAST' },
      { kind: 'BROADCAST' },
      { kind: 'BROADCAST' },
      { kind: 'OFFERED' },
      { kind: 'OFFERED' },
      { kind: 'DECLINED' },
      { kind: 'ACCEPTED' },
    ],
    offers: [
      { windowId: 'win_a', title: 'Table for 4', state: 'ACCEPTED', priceCents: 5000, payAt: 'venue' },
      { windowId: 'win_b', title: 'Chef counter', state: 'ACCEPTED', priceCents: 9000, payAt: 'bytspot' },
      { windowId: 'win_b', title: 'Chef counter', state: 'ACCEPTED', priceCents: 9000, payAt: 'bytspot' },
    ],
    checkouts: [
      { status: 'completed', amountCents: 9000, sellerNetCents: 8100 },
      { status: 'refunded', amountCents: 9000, sellerNetCents: 8100 },
    ],
  });

  assert.equal(summary.requests, 3);
  assert.equal(summary.offers, 2);
  assert.equal(summary.declined, 1);
  assert.equal(summary.booked, 1);
  assert.equal(summary.winRate, 50);
  assert.equal(summary.paidCents, 9000);
  assert.equal(summary.netCents, 8100);
  assert.equal(summary.refunds, 1);
  assert.equal(summary.payAtVenueCents, 5000);
  assert.deepEqual(summary.top.map((row) => [row.windowId, row.booked]), [['win_b', 2], ['win_a', 1]]);
});

test('a business with no offers has no win rate rather than zero percent', () => {
  assert.equal(summarizeAnalytics({ days: 7, events: [], offers: [], checkouts: [] }).winRate, null);
});

test('check-ins count every proven visit and each guest once', () => {
  const summary = summarizeAnalytics({
    days: 30, events: [], offers: [], checkouts: [],
    checkIns: [{ userId: 'ada' }, { userId: 'ada' }, { userId: 'kofi' }],
  });
  assert.equal(summary.checkIns, 3);
  assert.equal(summary.checkInGuests, 2);
  const none = summarizeAnalytics({ days: 7, events: [], offers: [], checkouts: [] });
  assert.equal(none.checkIns, 0);
  assert.equal(none.checkInGuests, 0);
});

test('the dashboard counts proven check-ins only at the business\'s own linked places', async () => {
  const stubs = db as any;
  const saved = {
    location: stubs.vendorLocation.findMany, events: stubs.demandEvent.findMany, offers: stubs.offer.findMany,
    checkouts: stubs.offerCheckout.findMany, tickets: stubs.vendorTicketOrder.findMany, checkIns: stubs.checkIn.findMany,
  };
  const now = new Date('2026-11-10T20:00:00Z');
  let checkInQuery: any;
  let linkedQuery: any;
  stubs.demandEvent.findMany = async () => [];
  stubs.offer.findMany = async () => [];
  stubs.offerCheckout.findMany = async () => [];
  stubs.vendorTicketOrder.findMany = async () => [];
  stubs.checkIn.findMany = async (query: any) => { checkInQuery = query; return [{ userId: 'ada' }, { userId: 'kofi' }, { userId: 'ada' }]; };
  try {
    stubs.vendorLocation.findMany = async (query: any) => { linkedQuery = query; return [{ menuVenueId: 'venue-vidash' }]; };
    const summary = await loadAnalytics('seller-1', 30, now);
    assert.deepEqual(linkedQuery.where, { sellerId: 'seller-1', menuVenueId: { not: null } });
    assert.deepEqual(checkInQuery.where.venueId, { in: ['venue-vidash'] });
    assert.deepEqual(checkInQuery.where.proof, { not: 'self_reported' });
    assert.equal(checkInQuery.where.createdAt.gte.toISOString(), '2026-10-11T20:00:00.000Z');
    assert.deepEqual(checkInQuery.select, { userId: true });
    assert.equal(summary.checkIns, 3);
    assert.equal(summary.checkInGuests, 2);

    checkInQuery = undefined;
    stubs.vendorLocation.findMany = async () => [];
    const unlinked = await loadAnalytics('seller-1', 30, now);
    assert.equal(checkInQuery, undefined, 'no linked place means no check-in read');
    assert.equal(unlinked.checkIns, 0);
  } finally {
    stubs.vendorLocation.findMany = saved.location; stubs.demandEvent.findMany = saved.events; stubs.offer.findMany = saved.offers;
    stubs.offerCheckout.findMany = saved.checkouts; stubs.vendorTicketOrder.findMany = saved.tickets; stubs.checkIn.findMany = saved.checkIns;
  }
});

test('only the offered ranges are accepted', () => {
  assert.equal(analyticsRange('7'), 7);
  assert.equal(analyticsRange('90'), 90);
  assert.equal(analyticsRange('365'), 30);
  assert.equal(analyticsRange(undefined), 30);
});

test('payout totals count paid bookings only', () => {
  assert.deepEqual(
    payoutTotals([
      { status: 'completed', netCents: 900, feeCents: 100 },
      { status: 'completed', netCents: 1800, feeCents: 200 },
      { status: 'refunded', netCents: 900, feeCents: 100 },
    ]),
    { netCents: 2700, feeCents: 300, bookings: 2, refunds: 1 },
  );
});

test('slot operations follow the contract\'s from-states', () => {
  assert.equal(slotOperationAllowed('BLOCK_SLOT', 'OPEN'), true);
  assert.equal(slotOperationAllowed('OPEN_SLOT', 'BLOCKED'), true);
  assert.equal(slotOperationAllowed('OPEN_SLOT', 'OPEN'), false);
  assert.equal(slotOperationAllowed('CLOSE_SLOT', 'PASSED'), false);
  assert.deepEqual(commitmentFlags('CLOSE_SLOT'), { blocked: false, closed: true });
  assert.deepEqual(commitmentFlags('OPEN_SLOT'), { blocked: false, closed: false });
});

test('a schedule cannot drop below what is already booked', () => {
  const schedule = { weekdays: [5], openMins: 18 * 60, closeMins: 22 * 60, quantity: 2 };
  assert.deepEqual(scheduleBlockers(schedule, 'dining', 2), []);
  assert.deepEqual(scheduleBlockers(schedule, 'dining', 3), ['3 already booked in one slot, so keep at least 3']);
  assert.deepEqual(scheduleBlockers({ ...schedule, closeMins: 17 * 60 }, 'dining', 0), ['Closing has to come after opening']);
});

test('earnings count app money on the day paid and venue money on the day of the visit', () => {
  const summary = summarizeEarnings({
    days: 7,
    checkouts: [
      { at: new Date('2026-10-02T03:30:00Z'), status: 'completed', amountCents: 5000, feeCents: 500, netCents: 4500, timezone: 'America/New_York' },
      { at: new Date('2026-10-02T15:00:00Z'), status: 'refunded', amountCents: 3000, feeCents: 300, netCents: 2700, timezone: 'America/New_York' },
    ],
    venue: [{ at: new Date('2026-10-02T23:00:00Z'), priceCents: 4000, timezone: 'America/New_York' }],
    upcomingVenueCents: 8000,
  });
  assert.deepEqual(summary.totals, {
    appGrossCents: 5000,
    feeCents: 500,
    appNetCents: 4500,
    refundedCents: 3000,
    venueCents: 4000,
    bookings: 2,
  });
  // 03:30 UTC on the 2nd is still the evening of the 1st in New York.
  assert.deepEqual(summary.daily, [
    { date: '2026-10-02', appNetCents: 0, venueCents: 4000, bookings: 1 },
    { date: '2026-10-01', appNetCents: 4500, venueCents: 0, bookings: 1 },
  ]);
  assert.equal(summary.upcomingVenueCents, 8000);
});

test('a place with no time zone, or a bad one, is dated in UTC', () => {
  assert.equal(localDate(new Date('2026-10-02T03:30:00Z')), '2026-10-02');
  assert.equal(localDate(new Date('2026-10-02T03:30:00Z'), 'Not/AZone'), '2026-10-02');
});
