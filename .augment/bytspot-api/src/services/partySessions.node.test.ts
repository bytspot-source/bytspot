import assert from 'node:assert/strict';
import { test } from 'node:test';
import { remainingSeats, sessionState, validateSessions, type SessionDraft, type SessionHostParty } from './partySessions';

const at = (iso: string) => new Date(iso);
const party: SessionHostParty = {
  startsAt: at('2026-10-01T18:00:00Z'),
  endsAt: at('2026-10-02T02:00:00Z'),
  capacity: 80,
  accessMode: 'paid-ticket',
};

function sitting(over: Partial<SessionDraft> = {}): SessionDraft {
  return {
    name: 'First Seating',
    startsAt: at('2026-10-01T19:00:00Z'),
    endsAt: at('2026-10-01T21:00:00Z'),
    capacity: 40,
    priceCents: 2500,
    ...over,
  };
}

test('A Party with no sittings is valid, because sessions are opt-in', () => {
  assert.deepEqual(validateSessions([], party), []);
});

test('Two sittings inside the Party window that fit the room are accepted', () => {
  const sessions = [
    sitting(),
    sitting({ name: 'Second Seating', startsAt: at('2026-10-01T21:30:00Z'), endsAt: at('2026-10-01T23:30:00Z') }),
  ];
  assert.deepEqual(validateSessions(sessions, party), []);
});

test('A sitting cannot escape the Party window at either end', () => {
  const early = validateSessions([sitting({ startsAt: at('2026-10-01T17:00:00Z') })], party);
  assert.deepEqual(early, [{ index: 0, field: 'startsAt', message: 'A sitting cannot start before the Party does.' }]);

  const late = validateSessions([sitting({ endsAt: at('2026-10-02T03:00:00Z') })], party);
  assert.deepEqual(late, [{ index: 0, field: 'endsAt', message: 'A sitting cannot end after the Party does.' }]);
});

test('An unstated Party end bounds nothing, because unknown is not midnight', () => {
  // Inventing a ceiling would refuse a sitting the host never said was too
  // late. The floor still holds.
  const open = { ...party, endsAt: null };
  assert.deepEqual(validateSessions([sitting({ endsAt: at('2026-10-03T04:00:00Z') })], open), []);
  assert.deepEqual(
    validateSessions([sitting({ startsAt: at('2026-10-01T17:00:00Z') })], open),
    [{ index: 0, field: 'startsAt', message: 'A sitting cannot start before the Party does.' }],
  );
});

test('Sittings may overlap, but together they cannot sell more than the room holds', () => {
  // Two rooms at once is legitimate. Selling 100 seats in an 80-seat room is
  // not, however the sittings are arranged in time.
  const overlapping = [sitting({ capacity: 40 }), sitting({ name: 'Balcony', capacity: 40 })];
  assert.deepEqual(validateSessions(overlapping, party), []);

  const oversold = [sitting({ capacity: 50 }), sitting({ name: 'Balcony', capacity: 50 })];
  assert.deepEqual(validateSessions(oversold, party), [{
    index: null,
    field: 'capacity',
    message: 'These sittings sell 100 seats, which is more than the Party holds (80).',
  }]);
});

test('Only a paid Party can price a sitting', () => {
  const free: SessionHostParty = { ...party, accessMode: 'free-rsvp' };
  assert.deepEqual(validateSessions([sitting({ priceCents: 2500 })], free), [
    { index: 0, field: 'priceCents', message: 'Only paid Parties can price a sitting.' },
  ]);
  // Zero is a free sitting, not an unpriced one.
  assert.deepEqual(validateSessions([sitting({ priceCents: 0 })], free), []);
});

test('Two sittings cannot share a name, because a pass could not tell them apart', () => {
  const clash = [sitting(), sitting({ startsAt: at('2026-10-01T21:30:00Z'), endsAt: at('2026-10-01T23:00:00Z') })];
  assert.deepEqual(validateSessions(clash, party), [
    { index: 1, field: 'name', message: 'Two sittings cannot share a name.' },
  ]);
});

test('Every complaint arrives at once, indexed to the sitting that caused it', () => {
  // A host fixing a four-sitting evening should not be told one problem per
  // attempt.
  const issues = validateSessions([
    sitting({ name: '  ', capacity: 0 }),
    sitting({ name: 'Second', startsAt: at('2026-10-01T23:00:00Z'), endsAt: at('2026-10-01T22:00:00Z') }),
  ], party);

  assert.deepEqual(issues.filter((issue) => issue.index === 0).map((issue) => issue.field).sort(), ['capacity', 'name']);
  assert.deepEqual(issues.filter((issue) => issue.index === 1).map((issue) => issue.field), ['endsAt']);
});

test('Full and passed are different facts and are never collapsed', () => {
  const now = at('2026-10-01T18:30:00Z');
  const upcoming = { startsAt: at('2026-10-01T19:00:00Z'), capacity: 40, committed: 10 };

  assert.equal(sessionState(upcoming, now), 'open');
  assert.equal(sessionState({ ...upcoming, committed: 40 }, now), 'full');
  // Come back for the next sitting, versus this one already happened.
  assert.equal(sessionState({ ...upcoming, startsAt: at('2026-10-01T18:00:00Z') }, now), 'passed');
  assert.equal(sessionState({ ...upcoming, startsAt: at('2026-10-01T18:00:00Z'), committed: 40 }, now), 'passed');
});

test('Remaining seats never reports a negative room', () => {
  assert.equal(remainingSeats({ capacity: 40, committed: 10 }), 30);
  assert.equal(remainingSeats({ capacity: 40, committed: 40 }), 0);
  assert.equal(remainingSeats({ capacity: 40, committed: 41 }), 0);
});
