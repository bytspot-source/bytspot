import assert from 'node:assert/strict';
import test from 'node:test';

import { LIVE_CROWD_FRESH_MS } from './latestCrowd';
import { typicalJitter, typicalLevel, typicalWaitMins, TYPICAL_LABELS } from './typicalOccupancy';
import {
  attachRightNow,
  bestTimeForVenueDetail,
  bestTimeToGo,
  formatAtlantaIso,
} from './bestTimeToGo';

const FRIDAY = { startsAt: new Date('2026-11-06T16:00:00-05:00'), endsAt: new Date('2026-11-06T23:00:00-05:00') };
const NOW = new Date('2026-11-06T21:10:00-05:00');

test('ranks calmer arrivals first and labels them from the typical curve', () => {
  const result = bestTimeToGo({
    venue: { category: 'bar', slug: 'stable-bar-3' },
    window: FRIDAY,
    slotMinutes: 30,
    now: NOW,
  });
  assert.equal(result.source, 'typical');
  assert.equal(result.slotMinutes, 30);
  assert.equal(result.summary, 'Typically quieter before 5:00 PM (estimate)');
  assert.doesNotMatch(result.summary, /right now|live|empty|scarce/i);
  assert.equal(result.driveMinutes, null);
  assert.equal(result.preferredLeaveBy, null);
  assert.equal(result.rightNow, null);

  const levels = result.slots.map((slot) => slot.level);
  assert.deepEqual(levels, [...levels].sort((a, b) => a - b));
  assert.equal(result.slots[0].level, 1);
  assert.equal(result.slots[0].label, 'Chill');
  assert.equal(result.preferredArrivalAt, result.slots[0].arrivalAt);
  assert.ok(result.slots.some((slot) => slot.level === 4));

  for (const slot of result.slots) {
    const at = new Date(slot.arrivalAt);
    const hour = Number(slot.arrivalAt.slice(11, 13));
    const expected = typicalJitter(typicalLevel(hour, 5, 'bar'), 'stable-bar-3', hour, 5);
    assert.equal(slot.level, expected, slot.arrivalAt);
    assert.equal(slot.label, TYPICAL_LABELS[expected]);
    assert.equal(slot.waitMins, typicalWaitMins(expected));
    assert.equal(slot.arrivalAt, formatAtlantaIso(at));
    assert.equal('leaveBy' in slot, false);
    assert.equal('driveMinutes' in slot, false);
  }
});

test('a slug that jitters changes the level, and a stable slug does not', () => {
  const window = { startsAt: new Date('2026-11-06T16:00:00-05:00'), endsAt: new Date('2026-11-06T16:30:00-05:00') };
  const calm = bestTimeToGo({ venue: { category: 'bar', slug: 'stable-bar-3' }, window, slotMinutes: 30, now: NOW });
  const bumped = bestTimeToGo({ venue: { category: 'bar', slug: 'jitter-bar-0' }, window, slotMinutes: 30, now: NOW });
  assert.equal(calm.slots[0].level, 1);
  assert.equal(bumped.slots[0].level, 2);
  assert.equal(bumped.slots[0].label, 'Active');
});

test('leave-by is arrival minus a known drive, and is omitted when drive time is unknown', () => {
  const window = { startsAt: new Date('2026-11-06T21:00:00-05:00'), endsAt: new Date('2026-11-06T21:30:00-05:00') };
  const driven = bestTimeToGo({
    venue: { category: 'bar', slug: 'stable-bar-3' },
    window,
    slotMinutes: 30,
    driveMinutes: 25,
    now: NOW,
  });
  assert.equal(driven.driveMinutes, 25);
  assert.equal(driven.slots.length, 1);
  assert.equal(driven.slots[0].arrivalAt, '2026-11-06T21:00:00-05:00');
  assert.equal(driven.slots[0].leaveBy, '2026-11-06T20:35:00-05:00');
  assert.equal(driven.slots[0].driveMinutes, 25);
  assert.equal(driven.preferredLeaveBy, '2026-11-06T20:35:00-05:00');

  const alreadyThere = bestTimeToGo({
    venue: { category: 'bar', slug: 'stable-bar-3' },
    window, slotMinutes: 30, driveMinutes: 0, now: NOW,
  });
  assert.equal(alreadyThere.slots[0].leaveBy, alreadyThere.slots[0].arrivalAt);

  const unknown = bestTimeToGo({
    venue: { category: 'bar', slug: 'stable-bar-3' },
    window,
    slotMinutes: 30,
    origin: { lat: 33.78, lng: -84.38 },
    driveMinutes: null,
    now: NOW,
  });
  assert.equal(unknown.driveMinutes, null);
  assert.equal(unknown.preferredLeaveBy, null);
  assert.equal('leaveBy' in unknown.slots[0], false);

  const nonsense = bestTimeToGo({
    venue: { category: 'bar', slug: 'stable-bar-3' },
    window, slotMinutes: 30, driveMinutes: -5, now: NOW,
  });
  assert.equal(nonsense.driveMinutes, null);
  assert.equal('leaveBy' in nonsense.slots[0], false);
});

test('the summary says after when the calmer hours are later, and names the level when the window is flat', () => {
  const later = bestTimeToGo({
    venue: { category: 'coffee', slug: 'stable-coffee-6' },
    window: { startsAt: new Date('2026-11-04T14:00:00-05:00'), endsAt: new Date('2026-11-04T21:00:00-05:00') },
    slotMinutes: 30,
    now: new Date('2026-11-04T12:00:00-05:00'),
  });
  assert.equal(later.summary, 'Typically quieter after 7:00 PM (estimate)');
  assert.equal(later.source, 'typical');

  const flat = bestTimeToGo({
    venue: { category: 'club', slug: 'stable-club-3' },
    window: { startsAt: new Date('2026-11-03T08:00:00-05:00'), endsAt: new Date('2026-11-03T11:00:00-05:00') },
    slotMinutes: 30,
    now: new Date('2026-11-03T07:00:00-05:00'),
  });
  assert.equal(flat.summary, 'Typically chill through this window (estimate)');
  assert.ok(flat.slots.every((slot) => slot.level === 1 && slot.label === 'Chill'));
});

test('slots use Atlanta time, including daylight saving', () => {
  const result = bestTimeToGo({
    venue: { category: 'bar', slug: 'stable-bar-3' },
    window: { startsAt: new Date('2026-07-04T18:00:00.000Z'), endsAt: new Date('2026-07-04T18:30:00.000Z') },
    slotMinutes: 30,
    now: new Date('2026-07-04T17:00:00.000Z'),
  });
  assert.equal(result.slots[0].arrivalAt, '2026-07-04T14:00:00-04:00');
  assert.equal(result.slots[0].level, typicalJitter(typicalLevel(14, 6, 'bar'), 'stable-bar-3', 14, 6));
  assert.equal(typicalLevel(14, 6, 'bar'), 1);
});

test('fifteen-minute slots cover a short window and an empty window invents nothing', () => {
  const short = bestTimeToGo({
    venue: { category: 'bar', slug: 'stable-bar-3' },
    window: { startsAt: new Date('2026-11-06T16:00:00-05:00'), endsAt: new Date('2026-11-06T17:00:00-05:00') },
    now: NOW,
  });
  assert.equal(short.slotMinutes, 15);
  assert.deepEqual(short.slots.map((slot) => slot.arrivalAt), [
    '2026-11-06T16:00:00-05:00',
    '2026-11-06T16:15:00-05:00',
    '2026-11-06T16:30:00-05:00',
    '2026-11-06T16:45:00-05:00',
  ]);

  const none = bestTimeToGo({
    venue: { category: 'bar', slug: 'stable-bar-3' },
    window: { startsAt: new Date('2026-11-06T16:05:00-05:00'), endsAt: new Date('2026-11-06T16:10:00-05:00') },
    slotMinutes: 30,
    now: NOW,
  });
  assert.deepEqual(none.slots, []);
  assert.equal(none.preferredArrivalAt, null);
  assert.equal(none.summary, 'No arrival times in this window (estimate)');
  assert.equal(none.source, 'typical');
});

test('a fresh live reading is right now and does not rewrite the typical slots', () => {
  const without = bestTimeToGo({
    venue: { category: 'bar', slug: 'stable-bar-3' },
    window: FRIDAY, slotMinutes: 30, now: NOW,
  });
  const fresh = bestTimeToGo({
    venue: { category: 'bar', slug: 'stable-bar-3' },
    window: FRIDAY, slotMinutes: 30, now: NOW,
    live: { level: 4, label: 'Packed', source: 'user_report', recordedAt: new Date(NOW.getTime() - 10 * 60_000) },
  });
  assert.deepEqual(fresh.slots.map((slot) => slot.level), without.slots.map((slot) => slot.level));
  assert.equal(fresh.summary, without.summary);
  assert.doesNotMatch(fresh.summary, /right now/i);
  assert.equal(fresh.rightNow?.level, 4);
  assert.equal(fresh.rightNow?.label, 'Packed');
  assert.equal(fresh.rightNow?.source, 'user_report');
  assert.equal(fresh.rightNow?.line, "Right now it's packed.");
  assert.equal(fresh.rightNow?.recordedAt, '2026-11-06T21:00:00-05:00');

  for (const source of ['bytspot', 'sensor'] as const) {
    const reading = bestTimeToGo({
      venue: { category: 'bar', slug: 'stable-bar-3' },
      window: FRIDAY, slotMinutes: 30, now: NOW,
      live: { level: 2, source, recordedAt: new Date(NOW.getTime() - LIVE_CROWD_FRESH_MS) },
    });
    assert.equal(reading.rightNow?.source, source);
    assert.equal(reading.rightNow?.line, "Right now it's active.");
  }
});

test('a stale, typical, or future reading is not called right now', () => {
  const base = {
    venue: { category: 'bar', slug: 'stable-bar-3' },
    window: FRIDAY, slotMinutes: 30 as const, now: NOW,
  };
  const stale = bestTimeToGo({ ...base, live: { level: 4, source: 'sensor', recordedAt: new Date(NOW.getTime() - LIVE_CROWD_FRESH_MS - 1) } });
  const typical = bestTimeToGo({ ...base, live: { level: 1, label: 'Empty', source: 'typical', recordedAt: NOW } });
  const unnamed = bestTimeToGo({ ...base, live: { level: 1, source: 'guess', recordedAt: NOW } });
  assert.equal(stale.rightNow, null);
  assert.equal(typical.rightNow, null);
  assert.equal(unnamed.rightNow, null);
  assert.doesNotMatch(typical.summary, /empty|right now/i);

  const attached = attachRightNow(typical, { level: 3, source: 'bytspot', recordedAt: NOW }, NOW);
  assert.equal(typical.rightNow, null, 'attaching a reading does not mutate the cached estimate');
  assert.equal(attached.rightNow?.line, "Right now it's busy.");
  assert.equal(attached.summary, typical.summary);
});

test('venue detail estimates the next six hours and only mentions a fresh live reading', () => {
  const detail = bestTimeForVenueDetail(
    { category: 'bar', slug: 'stable-bar-3' },
    { level: 4, source: 'user_report', recordedAt: NOW },
    NOW,
  );
  assert.equal(detail.source, 'typical');
  assert.equal(detail.slotMinutes, 30);
  assert.equal(detail.window.startsAt, '2026-11-06T21:30:00-05:00');
  assert.equal(detail.window.endsAt, '2026-11-07T03:30:00-05:00');
  assert.equal(detail.driveMinutes, null);
  assert.equal(detail.rightNow?.line, "Right now it's packed.");
  assert.doesNotMatch(detail.summary, /right now|empty/i);
});
