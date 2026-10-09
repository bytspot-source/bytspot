import assert from 'node:assert/strict';
import { test } from 'node:test';
import { db } from '../lib/db';
import {
  handleUrl,
  meetWindowProblem,
  normalizeHandle,
  paymentReminder,
  saleState,
  scrubClosedSaleMeetPoints,
  snapMeetPoint,
} from './privateSales';

test('a handle is stored only in the form its provider issues', () => {
  assert.equal(normalizeHandle('paypal', 'https://www.paypal.me/KojoSells'), 'KojoSells');
  assert.equal(normalizeHandle('paypal', 'kojo.sells'), null);
  assert.equal(normalizeHandle('cashapp', '$kojo_atl'), 'kojo_atl');
  assert.equal(normalizeHandle('cashapp', 'https://cash.app/$kojo'), 'kojo');
  assert.equal(normalizeHandle('cashapp', '$12345'), null, 'a cashtag needs a letter');
  assert.equal(normalizeHandle('venmo', '@Kojo-Mensah'), 'Kojo-Mensah');
  assert.equal(normalizeHandle('venmo', 'venmo.com/u/Kojo-Mensah?txn=pay'), 'Kojo-Mensah');
  assert.equal(normalizeHandle('venmo', '@kojo'), null, 'Venmo usernames are at least 5 characters');
  assert.equal(handleUrl('cashapp', 'kojo'), 'https://cash.app/$kojo');
  assert.equal(handleUrl('venmo', 'Kojo-Mensah'), 'https://venmo.com/u/Kojo-Mensah');
  assert.match(paymentReminder('cashapp'), /no purchase protection/);
  assert.match(paymentReminder('paypal'), /Goods and Services/);
});

test('a meet point is stored to about 30 m, never the exact spot', () => {
  const snapped = snapMeetPoint(33.781234, -84.383456);
  assert.ok(Math.abs(snapped.lat - 33.781234) * 111_000 <= 16);
  assert.notEqual(snapped.lat, 33.781234);
  assert.deepEqual(snapMeetPoint(33.781230, -84.383450), snapped);
});

test('a meet window starts within 7 days and lasts at most 4 hours', () => {
  const now = new Date('2026-10-09T12:00:00Z');
  const at = (h: number) => new Date(now.getTime() + h * 3_600_000);
  assert.equal(meetWindowProblem(at(1), at(3), now), null);
  assert.match(meetWindowProblem(at(-1), at(1), now)!, /future/);
  assert.match(meetWindowProblem(at(24 * 8), at(24 * 8 + 1), now)!, /7 days/);
  assert.match(meetWindowProblem(at(2), at(2), now)!, /end after/);
  assert.match(meetWindowProblem(at(1), at(5.5), now)!, /4 hours/);
});

test('an open sale whose window has passed is ended', () => {
  const now = new Date('2026-10-09T12:00:00Z');
  assert.equal(saleState({ status: 'open', windowEnd: new Date('2026-10-09T13:00:00Z') }, now), 'open');
  assert.equal(saleState({ status: 'open', windowEnd: new Date('2026-10-09T11:00:00Z') }, now), 'ended');
  assert.equal(saleState({ status: 'sold', windowEnd: new Date('2026-10-09T13:00:00Z') }, now), 'sold');
});

test('meet points are cleared 7 days after a sale closes or ends', async () => {
  const sale = db.privateSale as any;
  const original = sale.updateMany;
  let args: any;
  sale.updateMany = async (a: any) => { args = a; return { count: 2 }; };
  try {
    const now = new Date('2026-10-20T00:00:00Z');
    assert.deepEqual(await scrubClosedSaleMeetPoints(now), { scrubbed: 2 });
    const cutoff = new Date('2026-10-13T00:00:00Z');
    assert.deepEqual(args.where, { meetScrubbedAt: null, OR: [{ closedAt: { lte: cutoff } }, { status: 'open', windowEnd: { lte: cutoff } }] });
    assert.deepEqual(args.data, { meetLat: null, meetLng: null, meetPlaceName: null, meetScrubbedAt: now });
  } finally {
    sale.updateMany = original;
  }
});
