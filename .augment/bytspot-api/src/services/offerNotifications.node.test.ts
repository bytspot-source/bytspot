import assert from 'node:assert/strict';
import test from 'node:test';
import { priceLabel, whenLabel } from './offerNotifications';

/**
 * A notification about a held table is read on a deadline, so it has to say
 * enough to decide on: where, when, and what it costs.
 */

test('price is written the way a guest reads it', () => {
  assert.equal(priceLabel(2500), '$25');
  assert.equal(priceLabel(2550), '$25.50');
  // Not "$0": a free thing should say so.
  assert.equal(priceLabel(0), 'No charge');
});

test('the time is told in the timezone the place actually keeps', () => {
  // 23:00 UTC is a 7pm table in Atlanta. Telling a guest "11 PM" would send
  // them four hours late.
  const label = whenLabel(new Date('2026-09-19T23:00:00.000Z'), 'America/New_York');
  assert.match(label, /7:00/);
  assert.match(label, /Sat/);
});

test('a missing or unknown timezone still says something rather than nothing', () => {
  // The seller's data being incomplete must not silence a real offer.
  assert.notEqual(whenLabel(new Date('2026-09-19T23:00:00.000Z'), null), '');
  assert.notEqual(whenLabel(new Date('2026-09-19T23:00:00.000Z'), 'Mars/Olympus'), '');
});
