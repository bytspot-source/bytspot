import assert from 'node:assert/strict';
import { test } from 'node:test';
import { analyticsRange, payoutTotals, summarizeAnalytics } from './insights';
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
