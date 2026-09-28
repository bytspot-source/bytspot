import test from 'node:test';
import assert from 'node:assert/strict';
import bookingLinks from './contracts/table-booking-links.json';
import { tableBookingLinkErrors, tableBookingLinkFor, useTableBookingLinksForTest } from './tableBookingLinks';
import { withTableBooking } from '../trpc/placesRouter';

const good = { placeId: 'ChIJ_example-1', name: 'Example Grill', provider: 'opentable', url: 'https://www.opentable.com/r/example-grill-atlanta', checkedAt: '2026-09-28' };

test('the checked-in list is fit to serve', () => {
  assert.deepEqual(tableBookingLinkErrors(bookingLinks.links as never[]), []);
});

test('a good entry passes, for either provider', () => {
  assert.deepEqual(tableBookingLinkErrors([good, { ...good, placeId: 'ChIJ_example-2', provider: 'resy', url: 'https://resy.com/cities/atl/example' }]), []);
});

test('an entry that would put a broken or foreign button on a card is refused', () => {
  const cases: Array<[Record<string, unknown>, RegExp]> = [
    [{ ...good, placeId: '' }, /placeId/],
    [{ ...good, placeId: 'has space' }, /placeId/],
    [{ ...good, name: ' ' }, /name/],
    [{ ...good, provider: 'sevenrooms' }, /provider/],
    [{ ...good, url: 'http://www.opentable.com/r/x' }, /https/],
    [{ ...good, url: 'not a url' }, /https/],
    [{ ...good, url: 'https://resy.com/cities/atl/x' }, /opentable\.com/],
    [{ ...good, url: 'https://opentable.com.evil.example/r/x' }, /opentable\.com/],
    [{ ...good, checkedAt: 'last week' }, /checkedAt/],
  ];
  for (const [entry, reason] of cases) {
    const errors = tableBookingLinkErrors([entry as never]);
    assert.equal(errors.length, 1, JSON.stringify(entry));
    assert.match(errors[0], reason);
  }
  assert.match(tableBookingLinkErrors([good, good])[0], /twice/);
});

test('a place not on the list has no link', () => {
  assert.equal(tableBookingLinkFor(null), null);
  assert.equal(tableBookingLinkFor('ChIJ_not_listed'), null);
});

test('a listed place carries its link on the next read, and a pulled one drops it', () => {
  const place = { placeId: 'ChIJ_example-1', name: 'Example Grill' };
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
});
