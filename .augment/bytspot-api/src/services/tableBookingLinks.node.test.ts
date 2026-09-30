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

test('a link that would put a broken or foreign button on a card is refused', () => {
  const cases: Array<[string, string, RegExp]> = [
    ['sevenrooms', 'https://sevenrooms.com/x', /OpenTable or Resy/],
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
      { googlePlaceId: 'ChIJ_listed', bookingProvider: 'resy', bookingUrl: 'https://resy.com/cities/atl/listed' },
      { googlePlaceId: 'ChIJ_foreign', bookingProvider: 'resy', bookingUrl: 'https://evil.example/x' },
    ];
  };
  try {
    await refreshTableBookingLinks();
    assert.deepEqual(where, { discoverable: true, googlePlaceId: { not: null }, bookingUrl: { not: null } });
    assert.equal(tableBookingLinkFor('ChIJ_listed')?.label, 'Resy');
    assert.equal(tableBookingLinkFor('ChIJ_foreign'), null);

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
