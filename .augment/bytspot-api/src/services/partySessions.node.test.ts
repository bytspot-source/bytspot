import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  liveRemaining,
  sessionPriceFloors,
  sessionState,
  validateSessions,
  type SessionDraft,
} from './partySessions';

const at = (iso: string) => new Date(iso);

function draft(over: Partial<SessionDraft> = {}): SessionDraft {
  return {
    name: 'Front Table',
    kind: 'table',
    startsAt: at('2099-06-01T22:00:00Z'),
    endsAt: at('2099-06-02T02:00:00Z'),
    bottleCount: 4,
    bottleTerms: 'included',
    priceCents: 90000,
    quantity: 1,
    ...over,
  };
}

// ─── The rules that had to go ───────────────────────────────────────────────

test('An after-hours session may end long after the Party does', () => {
  // The rule this replaces refused exactly this, so the product could not be
  // sold at all.
  const issues = validateSessions([draft({
    kind: 'after-hours',
    startsAt: at('2099-06-02T02:00:00Z'),
    endsAt: at('2099-06-02T06:00:00Z'),
    venueName: 'The Annex',
    lat: 33.77,
    lng: -84.36,
  })]);
  assert.deepEqual(issues, []);
});

test('Bottle counts are never weighed against how many people the room holds', () => {
  // Ten sessions of twelve bottles is 120 bottles and says nothing about a
  // 40-person room. The old sum rejected correct floors as overselling.
  const sessions = Array.from({ length: 10 }, (_, index) =>
    draft({ name: `Table ${index}`, bottleCount: 12, quantity: 1 }));
  assert.deepEqual(validateSessions(sessions), []);
});

test('A session may be held somewhere the Party is not', () => {
  const issues = validateSessions([draft({ venueName: 'Sister Room', lat: 33.75, lng: -84.39 })]);
  assert.deepEqual(issues, []);
});

// ─── What a session must still state ────────────────────────────────────────

test('A session must end after it starts', () => {
  const issues = validateSessions([draft({ startsAt: at('2099-06-02T02:00:00Z'), endsAt: at('2099-06-01T22:00:00Z') })]);
  assert.deepEqual(issues, [{ index: 0, field: 'endsAt', message: 'A session must end after it starts.' }]);
});

test('A bottle minimum of zero bottles states no minimum', () => {
  const issues = validateSessions([draft({ bottleTerms: 'minimum', bottleCount: 0 })]);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].field, 'bottleCount');
});

test('A table with no bottles included is a vendor decision, not an error', () => {
  // Zero under `included` is a table sold without bottles, which is theirs to
  // offer. Only a minimum of nothing is incoherent.
  assert.deepEqual(validateSessions([draft({ bottleTerms: 'included', bottleCount: 0 })]), []);
});

test('A session states both coordinates or neither', () => {
  const issues = validateSessions([draft({ venueName: 'Sister Room', lat: 33.75, lng: null })]);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].field, 'lat');
});

test('A session that names nowhere it is held keeps the Party address', () => {
  assert.deepEqual(validateSessions([draft({ venueName: null, lat: null, lng: null })]), []);
});

test('A seller fixing an evening hears every complaint at once', () => {
  const issues = validateSessions([
    draft({ name: '', priceCents: -1 }),
    draft({ name: 'Front Table', quantity: 0 }),
    draft({ name: 'front table' }),
  ]);
  const fields = issues.map((issue) => `${issue.index}:${issue.field}`);
  assert.deepEqual(fields.sort(), ['0:name', '0:priceCents', '1:quantity', '2:name']);
});

// ─── Units, not seats ───────────────────────────────────────────────────────

test('Units left count the larger of what is settled and what is claimed', () => {
  // A settled checkout is both a committed unit and a completed row, so
  // adding them would take the same unit twice.
  assert.equal(liveRemaining({ quantity: 4, committed: 2 }, 2), 2);
  // A payment in flight has taken no unit yet and still holds one.
  assert.equal(liveRemaining({ quantity: 4, committed: 0 }, 3), 1);
  // A unit given away by the vendor has no checkout behind it.
  assert.equal(liveRemaining({ quantity: 4, committed: 3 }, 0), 1);
  assert.equal(liveRemaining({ quantity: 1, committed: 0 }, 1), 0);
});

test('A session states one fact about its room, whichever number is asked', () => {
  const future = { startsAt: at('2099-01-01T20:00:00Z') };
  assert.equal(sessionState(future, 2), 'open');
  assert.equal(sessionState(future, 0), 'full');
  // Already started outranks both: units may remain and still be unreachable.
  assert.equal(sessionState({ startsAt: at('2000-01-01T20:00:00Z') }, 4), 'passed');
});

// ─── A floor a guest can actually pay ───────────────────────────────────────

test('The cheapest all-in session is the floor a card may claim', () => {
  const floors = sessionPriceFloors([
    { partyId: 'party-1', priceCents: 120000, bottleTerms: 'included' },
    { partyId: 'party-1', priceCents: 90000, bottleTerms: 'included' },
  ]);
  assert.deepEqual(floors.get('party-1'), { fromCents: 90000, terms: 'included' });
});

test('A cheaper minimum never displaces a complete price', () => {
  // $200 + bottles is a smaller number than $900 all-in and a worse answer:
  // no guest pays $200. The card would quote a price that cannot happen.
  const floors = sessionPriceFloors([
    { partyId: 'party-1', priceCents: 90000, bottleTerms: 'included' },
    { partyId: 'party-1', priceCents: 20000, bottleTerms: 'minimum' },
  ]);
  assert.deepEqual(floors.get('party-1'), { fromCents: 90000, terms: 'included' });
});

test('Order does not decide the floor', () => {
  const floors = sessionPriceFloors([
    { partyId: 'party-1', priceCents: 20000, bottleTerms: 'minimum' },
    { partyId: 'party-1', priceCents: 90000, bottleTerms: 'included' },
  ]);
  assert.deepEqual(floors.get('party-1'), { fromCents: 90000, terms: 'included' });
});

test('A Party selling only minimums claims one, and carries the terms that say bottles are extra', () => {
  const floors = sessionPriceFloors([
    { partyId: 'party-1', priceCents: 30000, bottleTerms: 'minimum' },
    { partyId: 'party-1', priceCents: 20000, bottleTerms: 'minimum' },
  ]);
  assert.deepEqual(floors.get('party-1'), { fromCents: 20000, terms: 'minimum' });
});

test('A Party with no takeable session claims no floor at all', () => {
  // Absent is not zero: a Party selling nothing must not read as selling
  // something free.
  assert.equal(sessionPriceFloors([]).get('party-1'), undefined);
});
