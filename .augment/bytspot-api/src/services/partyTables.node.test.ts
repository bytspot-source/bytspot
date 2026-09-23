import assert from 'node:assert/strict';
import { test } from 'node:test';
import { remainingSeats, tableState, validateTables, type TableDraft, type TableHostParty } from './partyTables';

const at = (iso: string) => new Date(iso);
const party: TableHostParty = {
  startsAt: at('2026-10-01T18:00:00Z'),
  endsAt: at('2026-10-02T02:00:00Z'),
  capacity: 80,
  accessMode: 'paid-ticket',
};

function table(over: Partial<TableDraft> = {}): TableDraft {
  return {
    name: 'Front Table',
    startsAt: at('2026-10-01T19:00:00Z'),
    endsAt: at('2026-10-01T21:00:00Z'),
    capacity: 40,
    priceCents: 2500,
    ...over,
  };
}

test('A Party with no tables is valid, because tables are opt-in', () => {
  assert.deepEqual(validateTables([], party), []);
});

test('Two tables inside the Party window that fit the room are accepted', () => {
  const tables = [
    table(),
    table({ name: 'Balcony Two', startsAt: at('2026-10-01T21:30:00Z'), endsAt: at('2026-10-01T23:30:00Z') }),
  ];
  assert.deepEqual(validateTables(tables, party), []);
});

test('A table cannot escape the Party window at either end', () => {
  const early = validateTables([table({ startsAt: at('2026-10-01T17:00:00Z') })], party);
  assert.deepEqual(early, [{ index: 0, field: 'startsAt', message: 'A table cannot start before the Party does.' }]);

  const late = validateTables([table({ endsAt: at('2026-10-02T03:00:00Z') })], party);
  assert.deepEqual(late, [{ index: 0, field: 'endsAt', message: 'A table cannot end after the Party does.' }]);
});

test('An unstated Party end bounds nothing, because unknown is not midnight', () => {
  // Inventing a ceiling would refuse a table the host never said was too
  // late. The floor still holds.
  const open = { ...party, endsAt: null };
  assert.deepEqual(validateTables([table({ endsAt: at('2026-10-03T04:00:00Z') })], open), []);
  assert.deepEqual(
    validateTables([table({ startsAt: at('2026-10-01T17:00:00Z') })], open),
    [{ index: 0, field: 'startsAt', message: 'A table cannot start before the Party does.' }],
  );
});

test('Tables may overlap, but together they cannot sell more than the room holds', () => {
  // Two rooms at once is legitimate. Selling 100 seats in an 80-seat room is
  // not, however the tables are arranged in time.
  const overlapping = [table({ capacity: 40 }), table({ name: 'Balcony', capacity: 40 })];
  assert.deepEqual(validateTables(overlapping, party), []);

  const oversold = [table({ capacity: 50 }), table({ name: 'Balcony', capacity: 50 })];
  assert.deepEqual(validateTables(oversold, party), [{
    index: null,
    field: 'capacity',
    message: 'These tables sell 100 seats, which is more than the Party holds (80).',
  }]);
});

test('A priced table needs a payment rail, which only a paid Party has today', () => {
  const free: TableHostParty = { ...party, accessMode: 'free-rsvp' };
  assert.deepEqual(validateTables([table({ priceCents: 2500 })], free), [
    { index: 0, field: 'priceCents', message: 'Only a paid Party can charge for a table today, because that is the only Party with a payment rail.' },
  ]);
  // Zero is a free table, not an unpriced one.
  assert.deepEqual(validateTables([table({ priceCents: 0 })], free), []);
});

test('Two tables cannot share a name, because a pass could not tell them apart', () => {
  const clash = [table(), table({ startsAt: at('2026-10-01T21:30:00Z'), endsAt: at('2026-10-01T23:00:00Z') })];
  assert.deepEqual(validateTables(clash, party), [
    { index: 1, field: 'name', message: 'Two tables cannot share a name.' },
  ]);
});

test('Every complaint arrives at once, indexed to the table that caused it', () => {
  // A host fixing a four-table evening should not be told one problem per
  // attempt.
  const issues = validateTables([
    table({ name: '  ', capacity: 0 }),
    table({ name: 'Second', startsAt: at('2026-10-01T23:00:00Z'), endsAt: at('2026-10-01T22:00:00Z') }),
  ], party);

  assert.deepEqual(issues.filter((issue) => issue.index === 0).map((issue) => issue.field).sort(), ['capacity', 'name']);
  assert.deepEqual(issues.filter((issue) => issue.index === 1).map((issue) => issue.field), ['endsAt']);
});

test('Full and passed are different facts and are never collapsed', () => {
  const now = at('2026-10-01T18:30:00Z');
  const upcoming = { startsAt: at('2026-10-01T19:00:00Z'), capacity: 40, committed: 10 };

  assert.equal(tableState(upcoming, now), 'open');
  assert.equal(tableState({ ...upcoming, committed: 40 }, now), 'full');
  // Come back for the next table, versus this one already happened.
  assert.equal(tableState({ ...upcoming, startsAt: at('2026-10-01T18:00:00Z') }, now), 'passed');
  assert.equal(tableState({ ...upcoming, startsAt: at('2026-10-01T18:00:00Z'), committed: 40 }, now), 'passed');
});

test('Remaining seats never reports a negative room', () => {
  assert.equal(remainingSeats({ capacity: 40, committed: 10 }), 30);
  assert.equal(remainingSeats({ capacity: 40, committed: 40 }), 0);
  assert.equal(remainingSeats({ capacity: 40, committed: 41 }), 0);
});
