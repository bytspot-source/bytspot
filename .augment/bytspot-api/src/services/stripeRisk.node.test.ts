import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { Prisma } from '@prisma/client';
import { db } from '../lib/db';
import { applyChargeRiskEvent, closeShouldRefund, refundParty, refundPartyCheckout } from './stripeRisk';

// A small in-memory stand-in for the rows these flows touch.
type Row = Record<string, any>;
let events: Set<string>;
let checkouts: Row[];
let guests: Row[];
let claims: Row[];
let sessions: Row[];
let orders: Row[];

const matches = (row: Row, where: Row = {}): boolean => Object.entries(where).every(([key, want]) => {
  if (want && typeof want === 'object' && !Array.isArray(want)) {
    if ('in' in want) return (want.in as unknown[]).includes(row[key]);
    if ('gte' in want) return row[key] >= want.gte;
    if ('not' in want) return row[key] !== want.not;
  }
  return row[key] === want;
});
const apply = (row: Row, data: Row) => {
  for (const [key, value] of Object.entries(data)) {
    if (value && typeof value === 'object' && 'decrement' in value) row[key] -= value.decrement;
    else row[key] = value;
  }
};
const table = (rows: () => Row[]) => ({
  findMany: async ({ where, take, skip, cursor, orderBy }: any) => {
    let hit = rows().filter((r) => matches(r, where));
    if (orderBy?.id === 'asc') hit.sort((a, b) => String(a.id).localeCompare(String(b.id)));
    if (cursor?.id) {
      const index = hit.findIndex((r) => r.id === cursor.id);
      hit = index >= 0 ? hit.slice(index + (skip ?? 0)) : [];
    } else if (skip) {
      hit = hit.slice(skip);
    }
    if (take != null) hit = hit.slice(0, take);
    return hit;
  },
  findUnique: async ({ where }: any) => rows().find((r) => r.id === where.id) ?? null,
  update: async ({ where, data }: any) => { const r = rows().find((x) => x.id === where.id)!; apply(r, data); return r; },
  updateMany: async ({ where, data }: any) => { const hit = rows().filter((r) => matches(r, where)); hit.forEach((r) => apply(r, data)); return { count: hit.length }; },
});

const tx = {
  stripeWebhookEvent: {
    create: async ({ data }: any) => {
      if (events.has(data.id)) throw new Prisma.PrismaClientKnownRequestError('dup', { code: 'P2002', clientVersion: 'test' });
      events.add(data.id);
      return data;
    },
  },
  partyCheckout: table(() => checkouts),
  partyGuest: table(() => guests),
  partySessionClaim: table(() => claims),
  partySession: table(() => sessions),
  vendorTicketOrder: table(() => orders),
};
const anyDb = db as any;
anyDb.$transaction = async (fn: (t: typeof tx) => unknown) => fn(tx);
anyDb.partyCheckout = tx.partyCheckout;

beforeEach(() => {
  events = new Set();
  checkouts = [
    { id: 'co1', partyId: 'p1', partyGuestId: 'g1', userId: 'u1', ticketTierName: 'GA', sessionId: 's1', status: 'completed', paymentIntentId: 'pi_1' },
    { id: 'co2', partyId: 'p1', partyGuestId: 'g2', userId: 'u2', ticketTierName: 'GA', sessionId: null, status: 'refund-required', paymentIntentId: 'pi_2' },
    { id: 'co3', partyId: 'p1', partyGuestId: 'g3', userId: 'u3', ticketTierName: 'GA', sessionId: null, status: 'expired', paymentIntentId: null },
  ];
  guests = [
    { id: 'g1', status: 'ticketed', accessGranted: true, credential: 'abc' },
    { id: 'g2', status: 'refund-required', accessGranted: false, credential: null },
    { id: 'g3', status: 'pending', accessGranted: false, credential: null },
  ];
  claims = [{ id: 'c1', sessionId: 's1', partyId: 'p1', userId: 'u1', state: 'held' }];
  sessions = [{ id: 's1', committed: 1 }];
  orders = [{ id: 'o1', paymentIntentId: 'pi_1', status: 'completed' }];
});

const event = (id: string, type: string, object: Row) => ({ id, type, created: 1, data: { object } }) as any;

test('a new dispute flags the checkout, revokes the pass, releases the table and takes the order off the door', async () => {
  assert.equal(await applyChargeRiskEvent(event('evt_1', 'charge.dispute.created', { payment_intent: 'pi_1', status: 'needs_response' })), true);
  assert.ok(checkouts[0].disputedAt instanceof Date);
  assert.equal(checkouts[0].disputeStatus, 'needs_response');
  assert.deepEqual([guests[0].accessGranted, guests[0].status, guests[0].credential], [false, 'disputed', null]);
  assert.equal(claims[0].state, 'released');
  assert.equal(sessions[0].committed, 0);
  assert.equal(orders[0].status, 'disputed');
});

test('redelivering the same event is a no-op', async () => {
  await applyChargeRiskEvent(event('evt_1', 'charge.dispute.created', { payment_intent: 'pi_1', status: 'needs_response' }));
  sessions[0].committed = 1; // if the event re-applied, this would drop again
  claims[0].state = 'held';
  await applyChargeRiskEvent(event('evt_1', 'charge.dispute.created', { payment_intent: 'pi_1', status: 'needs_response' }));
  assert.equal(sessions[0].committed, 1);
  assert.equal(claims[0].state, 'held');
});

test('a dispute closed as won does not revoke anything', async () => {
  await applyChargeRiskEvent(event('evt_w', 'charge.dispute.closed', { payment_intent: 'pi_1', status: 'won' }));
  assert.equal(checkouts[0].disputeStatus, 'won');
  assert.equal(guests[0].accessGranted, true);
  assert.equal(orders[0].status, 'completed');
});

test('an early fraud warning freezes the payout and revokes the pass', async () => {
  await applyChargeRiskEvent(event('evt_f', 'radar.early_fraud_warning.created', { payment_intent: 'pi_1', charge: 'ch_1' }));
  assert.ok(checkouts[0].fraudWarningAt instanceof Date);
  assert.equal(guests[0].status, 'fraud-review');
  assert.equal(orders[0].status, 'disputed');
});

test('a full refund in Stripe marks the checkout refunded; a partial refund changes nothing', async () => {
  await applyChargeRiskEvent(event('evt_p', 'charge.refunded', { payment_intent: 'pi_1', refunded: false, amount_refunded: 100 }));
  assert.equal(checkouts[0].status, 'completed');
  assert.equal(guests[0].accessGranted, true);
  await applyChargeRiskEvent(event('evt_r', 'charge.refunded', { payment_intent: 'pi_1', refunded: true }));
  assert.equal(checkouts[0].status, 'refunded');
  assert.equal(guests[0].status, 'refunded');
  assert.equal(orders[0].status, 'refunded');
});

test('events the risk handler does not own are passed on', async () => {
  assert.equal(await applyChargeRiskEvent(event('evt_x', 'checkout.session.completed', {})), false);
});

function fakeStripe(fail = false) {
  const calls: Array<{ params: Row; options: Row }> = [];
  const stripe = {
    refunds: {
      create: async (params: Row, options: Row) => {
        calls.push({ params, options });
        if (fail) throw new Error('stripe down');
        return { id: `re_${params.payment_intent}` };
      },
    },
  };
  return { stripe: stripe as any, calls };
}

test('refunding a party refunds every paid checkout once, with a per-checkout idempotency key', async () => {
  const { stripe, calls } = fakeStripe();
  const result = await refundParty('p1', 'Host cancelled', stripe);
  assert.deepEqual(result, { refunded: 2, skipped: 0, failed: 0 });
  assert.deepEqual(calls.map((c) => c.options.idempotencyKey).sort(), ['party-refund:co1', 'party-refund:co2']);
  assert.equal(checkouts[0].status, 'refunded');
  assert.equal(checkouts[0].refundId, 're_pi_1');
  assert.equal(guests[0].accessGranted, false);
  assert.equal(guests[1].status, 'refunded');
  assert.equal(checkouts[2].status, 'expired', 'an unpaid checkout is never refunded');
  // Running it again (a host retrying cancel) issues no second refund.
  const again = await refundParty('p1', 'Host cancelled', stripe);
  assert.deepEqual(again, { refunded: 0, skipped: 0, failed: 0 });
  assert.equal(calls.length, 2);
});

test('a failed Stripe refund leaves the checkout as it was so a retry can finish it', async () => {
  const { stripe } = fakeStripe(true);
  assert.equal(await refundPartyCheckout('co1', 'x', stripe), 'failed');
  assert.equal(checkouts[0].status, 'completed');
  assert.equal(await refundPartyCheckout('co1', 'x', null), 'failed', 'no Stripe client means no refund, not a fake one');
});

test('the webhook auto-refund only touches a payment that could not be honoured', async () => {
  const { stripe, calls } = fakeStripe();
  assert.equal(await refundPartyCheckout('co1', 'auto', stripe, { statuses: ['refund-required'] }), 'skipped');
  assert.equal(await refundPartyCheckout('co2', 'auto', stripe, { statuses: ['refund-required'] }), 'refunded');
  assert.equal(calls.length, 1);
  assert.equal(checkouts[0].status, 'completed');
});

test('refundParty pages through every paid checkout rather than capping the list', async () => {
  const { stripe, calls } = fakeStripe();
  checkouts = Array.from({ length: 5 }, (_, i) => ({
    id: `co-${i + 1}`, partyId: 'p1', partyGuestId: `g-${i + 1}`, userId: `u-${i + 1}`,
    ticketTierName: 'GA', sessionId: null, status: 'completed', paymentIntentId: `pi-${i + 1}`,
  }));
  guests = checkouts.map((c) => ({ id: c.partyGuestId, status: 'ticketed', accessGranted: true, credential: 'x' }));
  const result = await refundParty('p1', 'Host cancelled', stripe, { pageSize: 2 });
  assert.deepEqual(result, { refunded: 5, skipped: 0, failed: 0 });
  assert.equal(calls.length, 5);
  assert.deepEqual(calls.map((c) => c.options.idempotencyKey).sort(), [
    'party-refund:co-1', 'party-refund:co-2', 'party-refund:co-3', 'party-refund:co-4', 'party-refund:co-5',
  ]);
});

test('close refunds when the night was not delivered, and keeps the money after a check-in or after it ends', () => {
  const endsAt = new Date('2026-11-10T23:00:00Z');
  const before = new Date('2026-11-10T20:00:00Z');
  const after = new Date('2026-11-10T23:30:00Z');
  assert.equal(closeShouldRefund({ endsAt }, 0, before), true);
  assert.equal(closeShouldRefund({ endsAt }, 1, before), false, 'a check-in means it was delivered');
  assert.equal(closeShouldRefund({ endsAt }, 0, after), false, 'after endsAt the night occurred');
  assert.equal(closeShouldRefund({ endsAt }, 0, endsAt), false);
});
