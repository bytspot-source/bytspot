import assert from 'node:assert/strict';
import { test } from 'node:test';
import { availabilityDefaultsFor, deriveSlots, sellableSlots, type DerivableWindow } from './availability';

/**
 * Slots are derived, so these assert the derivation rather than any stored row.
 * The cases that matter are the ones where "local" is not where the server is:
 * an Atlanta window must print Atlanta hours from a UTC process, and must keep
 * printing them across the day the clocks move.
 */

function window(overrides: Partial<DerivableWindow> = {}): DerivableWindow {
  return {
    id: 'window-1',
    domain: 'dining',
    weekdays: [0, 1, 2, 3, 4, 5, 6],
    openMins: 18 * 60,
    closeMins: 21 * 60,
    quantity: 4,
    slotKind: 'rolling',
    slotMinutes: 60,
    leadTimeMins: 60,
    horizonDays: 30,
    ...overrides,
  };
}

/** The wall-clock hour a slot lands on, read back in the seller's own zone. */
function localHour(instant: Date, timeZone: string): number {
  return Number(new Intl.DateTimeFormat('en-US', { timeZone, hour: '2-digit', hour12: false }).format(instant)) % 24;
}

test('a window prints the seller local hours, not the servers', () => {
  const slots = deriveSlots({
    window: window(),
    timeZone: 'America/New_York',
    from: new Date('2026-07-01T00:00:00Z'),
    now: new Date('2026-06-30T00:00:00Z'),
  });

  assert.ok(slots.length > 0);
  // A 6pm-to-9pm window is three one-hour slots: 6, 7, 8. Nine is the close,
  // and a slot starting at close would end after it.
  for (const slot of slots.slice(0, 3)) {
    assert.ok([18, 19, 20].includes(localHour(slot.startsAt, 'America/New_York')));
  }
  // Which is emphatically not what the same numbers mean in UTC.
  assert.notEqual(slots[0].startsAt.getUTCHours(), 18);
});

test('a window keeps its local hour across the day the clocks move', () => {
  // US DST ends 1 November 2026. The window must still open at 6pm local on
  // both sides, which it cannot do if the offset is resolved only once.
  const slots = deriveSlots({
    window: window({ slotMinutes: 60 }),
    timeZone: 'America/New_York',
    from: new Date('2026-10-30T12:00:00Z'),
    now: new Date('2026-10-29T00:00:00Z'),
  });

  const opens = new Map<string, number>();
  for (const slot of slots) {
    const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(slot.startsAt);
    if (!opens.has(day)) opens.set(day, localHour(slot.startsAt, 'America/New_York'));
  }

  const days = [...opens.keys()].slice(0, 4);
  assert.ok(days.length >= 3);
  for (const day of days) assert.equal(opens.get(day), 18);
});

test('a location with no timezone sells nothing rather than the wrong hour', () => {
  // A geocode that failed and nobody checked looks exactly like this. Printing
  // UTC slots would sell an Atlanta dinner at lunchtime.
  assert.deepEqual(deriveSlots({ window: window(), timeZone: null }), []);
});

test('only the declared weekdays print', () => {
  const slots = deriveSlots({
    window: window({ weekdays: [5] }),
    timeZone: 'America/New_York',
    from: new Date('2026-07-01T12:00:00Z'),
    now: new Date('2026-06-30T00:00:00Z'),
  });

  assert.ok(slots.length > 0);
  for (const slot of slots) assert.equal(slot.weekday, 5);
});

test('a commitment applies to its own instant and to no neighbour', () => {
  const from = new Date('2026-07-01T00:00:00Z');
  const bare = deriveSlots({ window: window(), timeZone: 'America/New_York', from, now: new Date('2026-06-30T00:00:00Z') });
  const target = bare[1];

  const slots = deriveSlots({
    window: window(),
    timeZone: 'America/New_York',
    from,
    now: new Date('2026-06-30T00:00:00Z'),
    commitments: [{ startsAt: target.startsAt, committed: 4, blocked: false, closed: false }],
  });

  assert.equal(slots[1].state, 'FULL');
  assert.equal(slots[1].remaining, 0);
  assert.equal(slots[0].state, 'OPEN');
  assert.equal(slots[2].state, 'OPEN');
});

test('a commitment whose instant no longer exists is ignored, not shifted', () => {
  // The seller moved the window after taking a booking. Applying that fact to
  // whichever slot happens to be nearest would close the wrong hour.
  const slots = deriveSlots({
    window: window(),
    timeZone: 'America/New_York',
    from: new Date('2026-07-01T00:00:00Z'),
    now: new Date('2026-06-30T00:00:00Z'),
    commitments: [{ startsAt: new Date('2026-07-01T03:17:00Z'), committed: 4, blocked: false, closed: false }],
  });

  for (const slot of slots) assert.equal(slot.committed, 0);
});

test('a commitment above the windows quantity is full, never negative', () => {
  const from = new Date('2026-07-01T00:00:00Z');
  const bare = deriveSlots({ window: window({ quantity: 2 }), timeZone: 'America/New_York', from, now: new Date('2026-06-30T00:00:00Z') });

  const slots = deriveSlots({
    window: window({ quantity: 2 }),
    timeZone: 'America/New_York',
    from,
    now: new Date('2026-06-30T00:00:00Z'),
    commitments: [{ startsAt: bare[0].startsAt, committed: 9, blocked: false, closed: false }],
  });

  assert.equal(slots[0].committed, 2);
  assert.equal(slots[0].remaining, 0);
  assert.equal(slots[0].state, 'FULL');
});

test('blocked outranks full, and passed outranks everything', () => {
  const from = new Date('2026-07-01T00:00:00Z');
  const bare = deriveSlots({ window: window(), timeZone: 'America/New_York', from, now: new Date('2026-06-30T00:00:00Z') });

  const blocked = deriveSlots({
    window: window(),
    timeZone: 'America/New_York',
    from,
    now: new Date('2026-06-30T00:00:00Z'),
    commitments: [{ startsAt: bare[0].startsAt, committed: 4, blocked: true, closed: false }],
  });
  assert.equal(blocked[0].state, 'BLOCKED');

  const passed = deriveSlots({
    window: window(),
    timeZone: 'America/New_York',
    from,
    // Now is after the first slot, whatever else was true of it.
    now: new Date(bare[0].startsAt.getTime() + 60_000),
    commitments: [{ startsAt: bare[0].startsAt, committed: 0, blocked: true, closed: false }],
  });
  assert.equal(passed[0].state, 'PASSED');
});

test('the lead time withholds a slot that is open but too close to sell', () => {
  const from = new Date('2026-07-01T00:00:00Z');
  const slots = deriveSlots({ window: window(), timeZone: 'America/New_York', from, now: new Date('2026-06-30T00:00:00Z') });

  // Standing thirty minutes before the first slot, the contract's hour of lead
  // time has not been met, so it is open on the calendar and unsellable.
  const justBefore = new Date(slots[0].startsAt.getTime() - 30 * 60_000);
  const sellable = sellableSlots(slots, 'dining', justBefore);
  assert.ok(!sellable.some((slot) => slot.startsAt.getTime() === slots[0].startsAt.getTime()));
});

test('a daily domain prints one slot a day, not a rolling grid', () => {
  // A room is sold by the night. The contract says so for stay, and the
  // derivation must read that rather than assume thirty-minute tables.
  assert.equal(availabilityDefaultsFor('stay').slotKind, 'daily');

  const slots = deriveSlots({
    window: window({ domain: 'stay', slotKind: 'daily', weekdays: [0, 1, 2, 3, 4, 5, 6] }),
    timeZone: 'America/New_York',
    from: new Date('2026-07-01T12:00:00Z'),
    now: new Date('2026-06-30T00:00:00Z'),
  });

  const perDay = new Map<string, number>();
  for (const slot of slots) {
    const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(slot.startsAt);
    perDay.set(day, (perDay.get(day) ?? 0) + 1);
  }
  for (const count of perDay.values()) assert.equal(count, 1);
});

test('the horizon is capped by the contract, not by what a seller typed', () => {
  const slots = deriveSlots({
    window: window({ horizonDays: 900, weekdays: [0, 1, 2, 3, 4, 5, 6] }),
    timeZone: 'America/New_York',
    from: new Date('2026-07-01T12:00:00Z'),
    now: new Date('2026-06-30T00:00:00Z'),
  });

  const days = new Set(slots.map((slot) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(slot.startsAt)));
  assert.ok(days.size <= availabilityDefaultsFor('dining').horizonDays);
});
