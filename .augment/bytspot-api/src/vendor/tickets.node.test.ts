import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { db } from '../lib/db';
import { linkBand, readBand } from './bands';
import { findByPass, listBookings, moveBooking } from './bookings';
import { payoutLines } from './insights';
import { stripeHandle } from './payout';
import {
  applyTicketCheckoutEvent,
  createTicket,
  editTicket,
  guestTicket,
  myTickets,
  settleTicketCheckout,
  startTicketCheckout,
  ticketState,
  ticketTimes,
  TicketRefused,
  withdrawTicket,
} from './tickets';

/**
 * Dated tickets, end to end against a real database where one is reachable:
 * the CHECK on `sold`, the one-ticket-per-guest index and the pass the
 * scanner reads. Skipped without one; CI always has one.
 */

const TZ = 'America/New_York';
const stamp = Date.now();
const ids = {
  seller: `tix-seller-${stamp}`,
  location: `tix-loc-${stamp}`,
  first: `tix-guest-a-${stamp}`,
  second: `tix-guest-b-${stamp}`,
  band: `BYT999-${String(stamp % 10_000).padStart(4, '0')}`,
  lostBand: `BYT998-${String(stamp % 10_000).padStart(4, '0')}`,
};
let reachable = false;
let sessionCount = 0;

before(async () => {
  try {
    await db.$queryRaw`SELECT 1`;
    reachable = true;
  } catch {
    return;
  }
  await db.vendorSeller.create({
    data: { id: ids.seller, legalName: 'Tix Kitchen', state: 'ACTIVE', payoutStatus: 'active', payoutReference: 'acct_tix_test' },
  });
  await db.vendorLocation.create({
    data: { id: ids.location, sellerId: ids.seller, label: 'Tix Kitchen Midtown', kind: 'fixed', state: 'ACTIVE', lat: 33.78, lng: -84.38, timezone: TZ },
  });
  for (const [id, name] of [
    [ids.first, 'Ama Mensah'],
    [ids.second, 'Kofi'],
  ]) {
    await db.user.create({ data: { id, email: `${id}@bytspot.test`, name, password: 'not-a-real-hash' } });
  }
});

after(async () => {
  if (!reachable) return;
  await db.vendorSeller.deleteMany({ where: { id: ids.seller } });
  await db.user.deleteMany({ where: { id: { in: [ids.first, ids.second] } } });
  await db.$disconnect();
});

function fakeStripe() {
  const calls = { sessions: [] as any[], refunds: [] as any[] };
  const stripe = {
    checkout: {
      sessions: {
        create: async (params: any) => {
          sessionCount += 1;
          const session = { ...params, id: `cs_tix_${sessionCount}_${stamp}`, url: `https://checkout.stripe.test/${sessionCount}` };
          calls.sessions.push(session);
          return session;
        },
      },
    },
    refunds: {
      create: async (params: any) => {
        calls.refunds.push(params);
        return { id: `re_tix_${calls.refunds.length}` };
      },
    },
  };
  return { stripe: stripe as unknown as import('stripe').default, calls };
}

/** The date and times an hour from now, on the place's own clock. */
function anHourFromNow(): { date: string; startTime: string } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })
      .formatToParts(new Date(Date.now() + 60 * 60_000))
      .map((part) => [part.type, part.value]),
  );
  return { date: `${parts.year}-${parts.month}-${parts.day}`, startTime: `${parts.hour === '24' ? '00' : parts.hour}:${parts.minute}` };
}

function paid(session: any, amount = session.line_items[0].price_data.unit_amount) {
  return { id: session.id, metadata: session.metadata, amount_total: amount, currency: 'usd', payment_intent: `pi_${session.id}`, mode: 'payment', payment_status: 'paid' } as any;
}

test('a date and two times are read on the place\'s clock, and an end before the start is the next day', () => {
  const summer = ticketTimes({ date: '2026-07-12', startTime: '13:00', endTime: '17:30' }, TZ);
  assert.equal(summer.startsAt.toISOString(), '2026-07-12T17:00:00.000Z');
  assert.equal(summer.endsAt.toISOString(), '2026-07-12T21:30:00.000Z');
  const winter = ticketTimes({ date: '2026-12-13', startTime: '20:00', endTime: '01:00' }, TZ);
  assert.equal(winter.startsAt.toISOString(), '2026-12-14T01:00:00.000Z');
  assert.equal(winter.endsAt.toISOString(), '2026-12-14T06:00:00.000Z');
});

test('a ticket is on sale until it sells out, stops or ends', () => {
  const now = new Date('2026-10-18T12:00:00Z');
  const base = { endsAt: new Date('2026-10-18T20:00:00Z'), quantity: 10, sold: 3, withdrawnAt: null };
  assert.equal(ticketState(base, now), 'on_sale');
  assert.equal(ticketState({ ...base, sold: 10 }, now), 'sold_out');
  assert.equal(ticketState({ ...base, withdrawnAt: now }, now), 'stopped');
  assert.equal(ticketState({ ...base, withdrawnAt: now }, new Date('2026-10-19T00:00:00Z')), 'ended');
});

test('other Stripe events are left for their own handlers', async () => {
  assert.equal(await applyTicketCheckoutEvent({ type: 'checkout.session.completed', data: { object: { metadata: { kind: 'offer-booking' } } } } as never), false);
  assert.equal(await applyTicketCheckoutEvent({ type: 'customer.subscription.updated', data: { object: {} } } as never), false);
});

test('a ticket is sold once per guest up to its cap, and its pass checks in once', async (t) => {
  if (!reachable) return t.skip('no database');
  const fake = fakeStripe();
  t.mock.method(stripeHandle, 'client', () => fake.stripe);

  await assert.rejects(
    createTicket(ids.seller, 'seat', { locationId: ids.location, title: 'Late', date: '2020-01-05', startTime: '13:00', endTime: '17:00', priceCents: 4500, quantity: 1 }),
    (err: unknown) => err instanceof TicketRefused && err.blockers[0] === 'Choose a date and time that has not started yet',
  );
  const ticket = await createTicket(ids.seller, 'seat', {
    locationId: ids.location,
    title: 'Sunday Ghanaian buffet',
    ...anHourFromNow(),
    endTime: '23:59',
    priceCents: 4500,
    quantity: 1,
  });
  assert.equal(ticket.state, 'on_sale');
  assert.match(ticket.url, /\?ticket=/);
  assert.equal((await guestTicket(ticket.id))?.remaining, 1);

  const first = await startTicketCheckout({ ticketId: ticket.id, userId: ids.first });
  assert.equal((await startTicketCheckout({ ticketId: ticket.id, userId: ids.first })).url, first.url, 'asking twice resumes the open checkout');
  await startTicketCheckout({ ticketId: ticket.id, userId: ids.second });
  const [firstSession, secondSession] = fake.calls.sessions;
  assert.equal(firstSession.payment_intent_data.transfer_data.destination, 'acct_tix_test');

  assert.equal(await settleTicketCheckout(paid(firstSession), fake.stripe), 'completed');
  assert.equal(await settleTicketCheckout(paid(firstSession), fake.stripe), 'completed', 'a redelivery changes nothing');
  assert.equal(await settleTicketCheckout(paid(secondSession), fake.stripe), 'refunded', 'the cap was reached while the second guest paid');
  assert.equal(fake.calls.refunds.length, 1);

  const [mine] = await myTickets(ids.first);
  assert.equal(mine.payment, 'paid');
  assert.match(mine.pass ?? '', /^[A-Z0-9]{8}$/);
  const [theirs] = await myTickets(ids.second);
  assert.equal(theirs.payment, 'refunded');
  assert.equal(theirs.refundReason, 'The last ticket went while you were paying.');
  await assert.rejects(startTicketCheckout({ ticketId: ticket.id, userId: ids.first }), (err: unknown) => err instanceof TicketRefused && /already have/.test(err.blockers[0]));

  const booking = await findByPass({ sellerId: ids.seller, code: mine.pass! });
  assert.equal(booking?.pass, 'ISSUED');
  assert.equal(booking?.guestName, 'Ama');
  assert.equal(booking?.payAt, 'bytspot');
  assert.equal(await findByPass({ sellerId: ids.seller, code: mine.pass!, windowIds: [] }), undefined, 'an assigned-scope seat sees no tickets');
  assert.deepEqual((await listBookings({ sellerId: ids.seller, when: 'upcoming' })).map((row) => row.id), [booking!.id]);

  const active = { sellerId: ids.seller, locationId: ids.location, tier: 'platinum', assignedByUserId: 'admin', activatedAt: new Date() };
  await db.vendorBand.create({ data: { ...active, serial: ids.band, state: 'active' } });
  await db.vendorBand.create({ data: { ...active, serial: ids.lostBand, state: 'lost', lostAt: new Date() } });
  assert.equal((await readBand(ids.seller, `https://bytspot.app/${ids.band}`)).booking, undefined, 'nobody wears the band yet');
  await assert.rejects(linkBand({ sellerId: ids.seller, seatId: 'seat', band: ids.band, bookingId: theirs.orderId }), /paid ticket/);
  assert.equal((await linkBand({ sellerId: ids.seller, seatId: 'seat', band: ids.band, bookingId: booking!.id })).holder, 'Ama');
  const tapped = await readBand(ids.seller, ids.band);
  assert.equal(tapped.booking?.id, booking!.id, 'a tap finds the guest\'s ticket for today');
  assert.equal(tapped.booking?.pass, 'ISSUED');
  await assert.rejects(readBand(ids.seller, ids.lostBand), /marked lost/);

  const checkedIn = await moveBooking({ sellerId: ids.seller, offerId: tapped.booking!.id, seatId: 'seat', operation: 'CHECK_IN' });
  assert.equal(checkedIn.pass, 'ADMITTED');
  await assert.rejects(moveBooking({ sellerId: ids.seller, offerId: booking!.id, seatId: 'seat', operation: 'CHECK_IN' }), /booking refused/);
  assert.equal((await readBand(ids.seller, ids.band)).booking?.pass, 'ADMITTED', 'the barcode and the band check in the same ticket once');
  assert.equal((await findByPass({ sellerId: ids.seller, code: mine.pass! }))?.pass, 'ADMITTED');

  await assert.rejects(editTicket(ids.seller, ticket.id, { quantity: 0 }), (err: unknown) => err instanceof TicketRefused && /1 is already sold/.test(err.blockers[0]));
  assert.equal((await editTicket(ids.seller, ticket.id, { priceCents: 5000, quantity: 3 })).quantity, 3);
  assert.equal((await withdrawTicket(ids.seller, ticket.id)).state, 'stopped');
  await assert.rejects(startTicketCheckout({ ticketId: ticket.id, userId: ids.second }), (err: unknown) => err instanceof TicketRefused && /no longer on sale/.test(err.blockers[0]));

  assert.deepEqual((await payoutLines(ids.seller)).map((line) => line.status).sort(), ['completed', 'refunded']);
});

test('a paid amount that does not match the ticket is refunded', async (t) => {
  if (!reachable) return t.skip('no database');
  const fake = fakeStripe();
  t.mock.method(stripeHandle, 'client', () => fake.stripe);
  const ticket = await createTicket(ids.seller, 'seat', { locationId: ids.location, title: 'Brunch', ...anHourFromNow(), endTime: '23:59', priceCents: 2500, quantity: 5 });
  await startTicketCheckout({ ticketId: ticket.id, userId: ids.second });
  assert.equal(await settleTicketCheckout(paid(fake.calls.sessions[0], 100), fake.stripe), 'refunded');
  assert.equal((await guestTicket(ticket.id))?.remaining, 5);
});
