import test from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../lib/db';
import {
  ensureTableBookingLinks,
  refreshTableBookingLinks,
  tableBookingLinkFor,
  tableBookingLinkFrom,
  tableBookingUrlError,
  useTableBookingLinksForTest,
} from './tableBookingLinks';
import { withTableBooking } from '../trpc/placesRouter';

const good = { placeId: 'ChIJ_example-1', provider: 'opentable', url: 'https://www.opentable.com/r/example-grill-atlanta' };

test('a good link passes, for either provider', () => {
  assert.equal(tableBookingUrlError('opentable', good.url), null);
  assert.equal(tableBookingUrlError('opentable', 'https://opentable.com/r/x'), null);
  assert.equal(tableBookingUrlError('resy', 'https://resy.com/cities/atl/example'), null);
  assert.deepEqual(tableBookingLinkFrom('resy', ' https://resy.com/cities/atl/example '), {
    provider: 'resy', label: 'Resy', url: 'https://resy.com/cities/atl/example',
  });
});

test('every new provider accepts a link on its own site, with its own label', () => {
  const cases: Array<[string, string, string]> = [
    ['tock', 'https://www.exploretock.com/example', 'Tock'],
    ['sevenrooms', 'https://www.sevenrooms.com/reservations/example', 'SevenRooms'],
    ['fareharbor', 'https://fareharbor.com/embeds/book/example/', 'FareHarbor'],
    ['peek', 'https://book.peek.com/s/example', 'Peek'],
    ['xola', 'https://checkout.xola.com/index.html#seller/example', 'Xola'],
    ['bookeo', 'https://bookeo.com/example', 'Bookeo'],
    ['vagaro', 'https://www.vagaro.com/example', 'Vagaro'],
    ['booksy', 'https://booksy.com/en-us/123_example', 'Booksy'],
    ['fresha', 'https://www.fresha.com/a/example', 'Fresha'],
    ['mindbody', 'https://clients.mindbodyonline.com/classic/ws?studioid=1', 'Mindbody'],
    ['eventbrite', 'https://www.eventbrite.com/o/example-123', 'Eventbrite'],
    ['dice', 'https://dice.fm/venue/example', 'DICE'],
    ['parkwhiz', 'https://www.parkwhiz.com/p/atlanta-parking/example/', 'ParkWhiz'],
    ['spothero', 'https://spothero.com/destination/atlanta/example', 'SpotHero'],
    ['blade', 'https://www.blade.com/airports/hartsfield-jackson-atlanta-international', 'Blade'],
    ['wheelsup', 'https://wheelsup.com/', 'Wheels Up'],
  ];
  for (const [provider, url, label] of cases) {
    assert.equal(tableBookingUrlError(provider, url), null, url);
    assert.equal(tableBookingLinkFrom(provider, url)?.label, label);
  }
  assert.equal(tableBookingLinkFrom('tock', 'https://www.exploretock.com/example', null), null, 'never checked is not shown to guests');
  assert.equal(tableBookingLinkFrom('tock', 'https://www.exploretock.com/example', new Date())?.label, 'Tock');
  const event = 'https://www.eventbrite.com/e/show-123';
  assert.equal(tableBookingLinkFrom('eventbrite', event, new Date(), new Date(Date.now() + 60_000))?.label, 'Eventbrite');
  assert.equal(tableBookingLinkFrom('eventbrite', event, new Date(), new Date(Date.now() - 60_000)), null, 'an event that is over is not shown');
  assert.equal(tableBookingLinkFrom('eventbrite', event, new Date(), null)?.label, 'Eventbrite', 'no end never expires');
});

test('a link that would put a broken or foreign button on a card is refused', () => {
  const cases: Array<[string, string, RegExp]> = [
    ['yelp', 'https://www.yelp.com/reservations/x', /booking provider/],
    ['fareharbor', 'https://fareharbor.com.evil.example/x', /fareharbor\.com/],
    ['blade', 'https://www.blade.com.evil.example/x', /blade\.com/],
    ['opentable', 'http://www.opentable.com/r/x', /https/],
    ['opentable', 'not a url', /https/],
    ['opentable', 'javascript:alert(1)', /https/],
    ['opentable', 'https://resy.com/cities/atl/x', /opentable\.com/],
    ['opentable', 'https://opentable.com.evil.example/r/x', /opentable\.com/],
    ['resy', 'https://www.resy.com.evil.example/x', /resy\.com/],
  ];
  for (const [provider, url, reason] of cases) {
    assert.match(tableBookingUrlError(provider, url) ?? '', reason, url);
    assert.equal(tableBookingLinkFrom(provider, url), null, url);
  }
  assert.equal(tableBookingLinkFrom(null, good.url), null);
});

test('a place not listed has no link', () => {
  const restore = useTableBookingLinksForTest([]);
  try {
    assert.equal(tableBookingLinkFor(null), null);
    assert.equal(tableBookingLinkFor('ChIJ_not_listed'), null);
  } finally {
    restore();
  }
});

test('a listed place carries its link, and a pulled one drops it', () => {
  const place = { placeId: 'ChIJ_example-1', name: 'Example Grill' };
  const outer = useTableBookingLinksForTest([]);
  try {
    assert.equal(withTableBooking(place).booking, null);
    const restore = useTableBookingLinksForTest([good]);
    try {
      assert.deepEqual(withTableBooking(place).booking, { provider: 'opentable', label: 'OpenTable', url: good.url });
      assert.deepEqual(tableBookingLinkFor('places/ChIJ_example-1'), withTableBooking(place).booking);
      assert.throws(() => useTableBookingLinksForTest([{ ...good, url: 'http://x' }]), /invalid/);
    } finally {
      restore();
    }
    assert.equal(withTableBooking(place).booking, null);
  } finally {
    outer();
  }
});

test('the list is read from listed, discoverable venues, and a bad row is skipped', async () => {
  const original = db.venue.findMany;
  let where: unknown = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (db.venue as any).findMany = async (args: { where: unknown }) => {
    where = args.where;
    return [
      { googlePlaceId: 'ChIJ_listed', bookingProvider: 'resy', bookingUrl: 'https://resy.com/cities/atl/listed', bookingCheckedAt: new Date() },
      { googlePlaceId: 'ChIJ_foreign', bookingProvider: 'resy', bookingUrl: 'https://evil.example/x', bookingCheckedAt: new Date() },
      { googlePlaceId: 'ChIJ_stale', bookingProvider: 'resy', bookingUrl: 'https://resy.com/cities/atl/stale', bookingCheckedAt: new Date(Date.now() - 91 * 24 * 60 * 60 * 1000) },
    ];
  };
  try {
    await refreshTableBookingLinks();
    assert.deepEqual(where, { discoverable: true, googlePlaceId: { not: null }, bookingUrl: { not: null } });
    assert.equal(tableBookingLinkFor('ChIJ_listed')?.label, 'Resy');
    assert.equal(tableBookingLinkFor('ChIJ_foreign'), null);
    assert.equal(tableBookingLinkFor('ChIJ_stale'), null, 'a link nobody has checked in 90 days is hidden from guests');

    // Fresh for a while: a second read does not go back to the database.
    where = null;
    await ensureTableBookingLinks();
    assert.equal(where, null);

    // A failed refresh keeps the last good list.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (db.venue as any).findMany = async () => { throw new Error('database unavailable'); };
    await ensureTableBookingLinks(Date.now() + 60_000);
    assert.equal(tableBookingLinkFor('ChIJ_listed')?.label, 'Resy');
  } finally {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (db.venue as any).findMany = original;
  }
});
