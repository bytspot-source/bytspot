import assert from 'node:assert/strict';
import test from 'node:test';
import { db } from '../lib/db';
import { bookingLinkCheck, BOOKING_LINK_MAX_AGE_MS, BOOKING_LINK_REMIND_MS } from './bookingProviders';
import { bookingLinksToRecheck } from './bookingRecheck';

const DAY = 24 * 60 * 60 * 1000;
const now = new Date('2026-11-14T15:00:00Z');
const ago = (days: number) => new Date(now.getTime() - days * DAY);

test('a link is fine until 14 days before guests stop seeing it, then due, then hidden', () => {
  assert.equal(BOOKING_LINK_MAX_AGE_MS, 90 * DAY);
  assert.equal(BOOKING_LINK_REMIND_MS, 14 * DAY);
  assert.equal(bookingLinkCheck(ago(10), now.getTime()).status, 'ok');
  assert.equal(bookingLinkCheck(ago(75), now.getTime()).status, 'ok');
  assert.equal(bookingLinkCheck(ago(77), now.getTime()).status, 'due_soon');
  assert.equal(bookingLinkCheck(ago(90), now.getTime()).status, 'due_soon');
  assert.equal(bookingLinkCheck(ago(91), now.getTime()).status, 'stale');
  assert.deepEqual(bookingLinkCheck(null, now.getTime()), { status: 'stale', dueAt: null });
  assert.equal(bookingLinkCheck(ago(80), now.getTime()).dueAt?.toISOString(), new Date(ago(80).getTime() + 90 * DAY).toISOString());
});

test('the re-check list has hidden links first, then the soonest due, and nothing still fine', async () => {
  const venue = db.venue as unknown as { findMany: unknown };
  const original = venue.findMany;
  let where: unknown;
  venue.findMany = async (args: { where: unknown }) => {
    where = args.where;
    return [
      { id: 'fine', name: 'Fine Grill', bookingProvider: 'opentable', bookingUrl: 'https://www.opentable.com/r/fine', bookingCheckedAt: ago(10) },
      { id: 'soon', name: 'Soon Spa', bookingProvider: 'vagaro', bookingUrl: 'https://www.vagaro.com/soon', bookingCheckedAt: ago(80) },
      { id: 'hidden', name: 'Hidden Tours', bookingProvider: 'fareharbor', bookingUrl: 'https://fareharbor.com/hidden/', bookingCheckedAt: ago(120) },
      { id: 'sooner', name: 'Sooner Bar', bookingProvider: 'tock', bookingUrl: 'https://www.exploretock.com/sooner', bookingCheckedAt: ago(88) },
      { id: 'over', name: 'Over Show', bookingProvider: 'dice', bookingUrl: 'https://dice.fm/event/over', bookingCheckedAt: ago(5), bookingExpiresAt: ago(2) },
      { id: 'coming', name: 'Coming Show', bookingProvider: 'dice', bookingUrl: 'https://dice.fm/event/coming', bookingCheckedAt: ago(5), bookingExpiresAt: ago(-3) },
    ];
  };
  try {
    const items = await bookingLinksToRecheck(now);
    assert.deepEqual(where, { listedAt: { not: null }, discoverable: true, bookingUrl: { not: null } });
    assert.deepEqual(items.map((item) => [item.venueId, item.status, item.provider]), [
      ['hidden', 'stale', 'FareHarbor'],
      ['over', 'expired', 'DICE'],
      ['sooner', 'due_soon', 'Tock'],
      ['soon', 'due_soon', 'Vagaro'],
    ]);
  } finally {
    venue.findMany = original;
  }
});
