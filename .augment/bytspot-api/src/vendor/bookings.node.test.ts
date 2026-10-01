import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  PASS_LENGTH,
  PASS_QR_PREFIX,
  bookingOperationBlocker,
  bookingState,
  bookingsWhen,
  firstName,
  newPassCode,
  normalizePassCode,
  passState,
  toBookingDto,
  type BookingRow,
} from './bookings';

const SEVEN_PM = new Date('2026-10-02T23:00:00Z');
const at = (mins: number) => new Date(SEVEN_PM.getTime() + mins * 60_000);
const booking = (over: Partial<BookingRow> = {}): BookingRow => ({
  id: 'off_1',
  skuTemplateId: 'custom.table',
  locationId: 'loc_1',
  windowId: 'win_1',
  state: 'ACCEPTED',
  startsAt: SEVEN_PM,
  durationMins: 90,
  priceCents: 4000,
  payAt: 'venue',
  checkedInAt: null,
  noShowAt: null,
  location: { label: 'Main room', timezone: 'America/New_York' },
  window: { skuTemplateId: 'custom.table', title: 'Chef counter', durationMins: 90 },
  demand: { partySize: 2, note: 'Anniversary', raisedByUserId: 'u_1' },
  checkouts: [],
  ...over,
});

test('pass codes avoid characters that are misread aloud', () => {
  for (let i = 0; i < 200; i += 1) {
    const code = newPassCode();
    assert.equal(code.length, PASS_LENGTH);
    assert.doesNotMatch(code, /[01OI]/);
  }
});

test('a typed or scanned pass reads as the same code', () => {
  assert.equal(normalizePassCode('abcd-2345'), 'ABCD2345');
  assert.equal(normalizePassCode(' AB CD 23 45 '), 'ABCD2345');
  assert.equal(normalizePassCode(`${PASS_QR_PREFIX}ABCD2345`), 'ABCD2345');
  assert.equal(normalizePassCode('https://example.com/ABCD2345'), undefined);
  assert.equal(normalizePassCode('ABC'), undefined);
  assert.equal(normalizePassCode(42), undefined);
});

test('a booking is upcoming until it ends, then past unless someone recorded it', () => {
  assert.equal(bookingState(booking(), at(-60)), 'upcoming');
  assert.equal(bookingState(booking(), at(89)), 'upcoming');
  assert.equal(bookingState(booking(), at(90)), 'past');
  assert.equal(bookingState(booking({ checkedInAt: at(0) }), at(500)), 'checked_in');
  assert.equal(bookingState(booking({ noShowAt: at(20) }), at(30)), 'no_show');
});

test('pass state follows the contract: issued, admitted, expired, revoked', () => {
  assert.equal(passState(booking(), at(0)), 'ISSUED');
  assert.equal(passState(booking({ checkedInAt: at(0) }), at(10)), 'ADMITTED');
  assert.equal(passState(booking(), at(120)), 'EXPIRED');
  assert.equal(passState(booking({ noShowAt: at(20) }), at(30)), 'REVOKED');
  assert.equal(passState(booking({ state: 'DECLINED' }), at(0)), 'REVOKED');
});

test('check-in opens two hours early and closes when the booking ends', () => {
  assert.match(bookingOperationBlocker('CHECK_IN', booking(), at(-121)) ?? '', /too early/i);
  assert.equal(bookingOperationBlocker('CHECK_IN', booking(), at(-120)), undefined);
  assert.equal(bookingOperationBlocker('CHECK_IN', booking(), at(90)), undefined);
  assert.match(bookingOperationBlocker('CHECK_IN', booking(), at(91)) ?? '', /ended/);
  assert.match(bookingOperationBlocker('CHECK_IN', booking({ checkedInAt: at(0) }), at(5)) ?? '', /already checked in/i);
});

test('a no-show can only be recorded once the time has started, and never after a check-in', () => {
  assert.match(bookingOperationBlocker('NO_SHOW', booking(), at(-1)) ?? '', /started/);
  assert.equal(bookingOperationBlocker('NO_SHOW', booking(), at(0)), undefined);
  assert.equal(bookingOperationBlocker('NO_SHOW', booking(), at(600)), undefined);
  assert.match(bookingOperationBlocker('NO_SHOW', booking({ checkedInAt: at(0) }), at(5)) ?? '', /already checked in/i);
  assert.match(bookingOperationBlocker('NO_SHOW', booking({ state: 'DECLINED' }), at(5)) ?? '', /cancelled/);
});

test('a booking is shown with the service name, first name only, and how it is paid', () => {
  const dto = toBookingDto(booking({ checkouts: [{ status: 'completed' }], payAt: 'bytspot' }), firstName('  Ada Lovelace '), at(0));
  assert.equal(dto.title, 'Chef counter');
  assert.equal(dto.guestName, 'Ada');
  assert.equal(dto.paid, 'paid');
  assert.equal(dto.payAt, 'bytspot');
  assert.equal(dto.state, 'upcoming');
  assert.equal(dto.pass, 'ISSUED');
  assert.equal('passCode' in dto, false, 'the console never needs the code itself');
  assert.equal(toBookingDto(booking({ checkouts: [{ status: 'refunded' }] }), undefined, at(0)).paid, 'refunded');
  assert.equal(toBookingDto(booking(), undefined, at(0)).paid, 'at_venue');
  assert.equal(firstName(null), undefined);
  assert.equal(firstName('   '), undefined);
});

test('an unknown range reads as upcoming', () => {
  assert.equal(bookingsWhen('past'), 'past');
  assert.equal(bookingsWhen('everything'), 'upcoming');
});
