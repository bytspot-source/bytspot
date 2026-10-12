import type Stripe from 'stripe';
import { Prisma, type VendorTicketOrder } from '@prisma/client';
import { z } from 'zod';
import { config } from '../config';
import { db } from '../lib/db';
import { serializableTransactionWithRetry } from '../lib/transactions';
import { deliverPushNotification } from '../services/notificationDelivery';
import { currentPlatformFeeBps, splitBookingAmount, VENDOR_BOOKING_FEE_SCOPE } from '../services/platformFee';
import { zonedInstant } from './availability';
import { newPassCode } from './bookings';
import { stripeHandle } from './payout';

/**
 * Tickets a business sells itself, one date at a time: its Sunday special on
 * 18 October, then another on 25 October, each with its own price and cap.
 *
 * The guest pays through Stripe before anything is taken. The ticket is
 * counted when the payment is confirmed, and if the date sold out or stopped
 * selling in the meantime the charge is refunded in full. A paid ticket carries
 * a pass code the Pass scanner reads like a booking's.
 */

export const VENDOR_TICKET_KIND = 'vendor-ticket';

/** Stripe will not expire a Checkout Session sooner than 30 minutes. */
const CHECKOUT_MINUTES = 31;
const OPEN_STATES = ['creating', 'pending'];

export class TicketRefused extends Error {
  constructor(
    readonly blockers: string[],
    readonly status: 404 | 409 = 409,
  ) {
    super(blockers.join('; '));
  }
}

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const clock = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);

export const createTicketInput = z.object({
  locationId: z.string().trim().min(1).max(64),
  title: z.string().trim().min(1).max(80),
  details: z.string().trim().max(500).optional(),
  /** The date and times at the place, in its own time zone. */
  date: day,
  startTime: clock,
  /** At or before the start means the next day, e.g. 20:00 to 01:00. */
  endTime: clock,
  priceCents: z.number().int().min(100).max(1_000_000),
  quantity: z.number().int().min(1).max(2000),
});
export type CreateTicketInput = z.infer<typeof createTicketInput>;

export const editTicketInput = z
  .object({
    title: z.string().trim().min(1).max(80).optional(),
    /** Null clears it. */
    details: z.string().trim().max(500).nullable().optional(),
    priceCents: z.number().int().min(100).max(1_000_000).optional(),
    quantity: z.number().int().min(1).max(2000).optional(),
  })
  .refine((edit) => Object.values(edit).some((value) => value !== undefined));
export type EditTicketInput = z.infer<typeof editTicketInput>;

function minutes(time: string): number {
  const [hours, mins] = time.split(':').map(Number);
  return hours * 60 + mins;
}

/** The instants a date and two wall-clock times mean at a place. */
export function ticketTimes(input: { date: string; startTime: string; endTime: string }, timeZone: string): { startsAt: Date; endsAt: Date } {
  const [year, month, date] = input.date.split('-').map(Number);
  const start = minutes(input.startTime);
  let end = minutes(input.endTime);
  if (end <= start) end += 24 * 60;
  return { startsAt: zonedInstant(year, month, date, start, timeZone), endsAt: zonedInstant(year, month, date, end, timeZone) };
}

export type TicketState = 'on_sale' | 'sold_out' | 'stopped' | 'ended';

interface TicketFacts {
  endsAt: Date;
  quantity: number;
  sold: number;
  withdrawnAt: Date | null;
}

export function ticketState(ticket: TicketFacts, now: Date): TicketState {
  if (ticket.endsAt <= now) return 'ended';
  if (ticket.withdrawnAt) return 'stopped';
  return ticket.sold >= ticket.quantity ? 'sold_out' : 'on_sale';
}

/** Where a guest opens this date to buy it. */
export function ticketUrl(id: string): string {
  return `${config.frontendUrl.replace(/\/$/, '')}/?ticket=${encodeURIComponent(id)}`;
}

export interface TicketDto {
  id: string;
  locationId: string;
  place: string;
  title: string;
  details: string | null;
  startsAt: string;
  endsAt: string;
  timezone: string | null;
  priceCents: number;
  quantity: number;
  sold: number;
  state: TicketState;
  url: string;
}

const TICKET_INCLUDE = { location: { select: { label: true, timezone: true } } } as const;
type TicketRow = Prisma.VendorTicketGetPayload<{ include: typeof TICKET_INCLUDE }>;

export function toTicketDto(row: TicketRow, now: Date): TicketDto {
  return {
    id: row.id,
    locationId: row.locationId,
    place: row.location.label,
    title: row.title,
    details: row.details,
    startsAt: row.startsAt.toISOString(),
    endsAt: row.endsAt.toISOString(),
    timezone: row.location.timezone,
    priceCents: row.priceCents,
    quantity: row.quantity,
    sold: row.sold,
    state: ticketState(row, now),
    url: ticketUrl(row.id),
  };
}

/** Upcoming dates first, then the last 30 days. */
export async function listTickets(sellerId: string, now: Date = new Date()): Promise<TicketDto[]> {
  const rows = await db.vendorTicket.findMany({
    where: { sellerId, endsAt: { gt: new Date(now.getTime() - 30 * 86_400_000) } },
    include: TICKET_INCLUDE,
    orderBy: { startsAt: 'asc' },
    take: 200,
  });
  const dtos = rows.map((row) => toTicketDto(row, now));
  return [...dtos.filter((dto) => dto.state !== 'ended'), ...dtos.filter((dto) => dto.state === 'ended').reverse()];
}

export async function createTicket(sellerId: string, seatId: string, input: CreateTicketInput, now: Date = new Date()): Promise<TicketDto> {
  const [place, seller] = await Promise.all([
    db.vendorLocation.findFirst({ where: { id: input.locationId, sellerId, state: { not: 'CLOSED' } }, select: { id: true, timezone: true } }),
    db.vendorSeller.findUnique({ where: { id: sellerId }, select: { payoutStatus: true, payoutReference: true } }),
  ]);
  const blockers: string[] = [];
  if (!place) blockers.push('Choose one of your places');
  else if (!place.timezone) blockers.push('This place has no time zone yet. Check its address under Locations');
  if (seller?.payoutStatus !== 'active' || !seller.payoutReference) blockers.push('Set up payouts first. Guests pay through Stripe');
  if (blockers.length) throw new TicketRefused(blockers);

  const { startsAt, endsAt } = ticketTimes(input, place!.timezone!);
  if (startsAt <= now) throw new TicketRefused(['Choose a date and time that has not started yet']);
  const row = await db.vendorTicket.create({
    data: {
      sellerId,
      locationId: place!.id,
      title: input.title,
      details: input.details || null,
      startsAt,
      endsAt,
      priceCents: input.priceCents,
      quantity: input.quantity,
      createdBySeatId: seatId,
    },
    include: TICKET_INCLUDE,
  });
  return toTicketDto(row, now);
}

/**
 * Changes a date that is still selling. A new price applies to the next guest,
 * never to a ticket already bought, and the cap cannot drop below what sold.
 */
export async function editTicket(sellerId: string, id: string, edit: EditTicketInput, now: Date = new Date()): Promise<TicketDto> {
  const ticket = await db.vendorTicket.findFirst({ where: { id, sellerId }, select: { endsAt: true, withdrawnAt: true, sold: true } });
  if (!ticket) throw new TicketRefused(['That ticket is not here'], 404);
  if (ticket.endsAt <= now) throw new TicketRefused(['This date has ended']);
  if (ticket.withdrawnAt) throw new TicketRefused(['This date stopped selling']);
  if (edit.quantity !== undefined && edit.quantity < ticket.sold) {
    throw new TicketRefused([`${ticket.sold} ${ticket.sold === 1 ? 'is' : 'are'} already sold, so the cap cannot be lower`]);
  }
  const { count } = await db.vendorTicket.updateMany({
    where: { id, sellerId, withdrawnAt: null, ...(edit.quantity !== undefined ? { sold: { lte: edit.quantity } } : {}) },
    data: {
      ...(edit.title !== undefined ? { title: edit.title } : {}),
      ...(edit.details !== undefined ? { details: edit.details || null } : {}),
      ...(edit.priceCents !== undefined ? { priceCents: edit.priceCents } : {}),
      ...(edit.quantity !== undefined ? { quantity: edit.quantity } : {}),
    },
  });
  if (count === 0) throw new TicketRefused(['More sold just now. Try again']);
  return toTicketDto(await db.vendorTicket.findUniqueOrThrow({ where: { id }, include: TICKET_INCLUDE }), now);
}

/** Stops selling a date. Guests who already bought keep their tickets. */
export async function withdrawTicket(sellerId: string, id: string, now: Date = new Date()): Promise<TicketDto> {
  await db.vendorTicket.updateMany({ where: { id, sellerId, withdrawnAt: null }, data: { withdrawnAt: now } });
  const row = await db.vendorTicket.findFirst({ where: { id, sellerId }, include: TICKET_INCLUDE });
  if (!row) throw new TicketRefused(['That ticket is not here'], 404);
  return toTicketDto(row, now);
}

/* ── Guests ───────────────────────────────────────────────────────────── */

export interface GuestTicketDto {
  id: string;
  title: string;
  details: string | null;
  sellerName: string;
  place: { label: string; address: string | null; lat: number; lng: number };
  startsAt: string;
  endsAt: string;
  timezone: string | null;
  priceCents: number;
  remaining: number;
  state: TicketState;
}

const GUEST_TICKET_INCLUDE = {
  seller: { select: { legalName: true } },
  location: { select: { label: true, address: true, lat: true, lng: true, timezone: true } },
} as const;

/** Only a live business at a live place shows a ticket to guests. */
const LIVE_TICKET = { seller: { state: 'ACTIVE' }, location: { state: 'ACTIVE' } } satisfies Prisma.VendorTicketWhereInput;

export async function guestTicket(id: string, now: Date = new Date()): Promise<GuestTicketDto | undefined> {
  const row = await db.vendorTicket.findFirst({ where: { id, ...LIVE_TICKET }, include: GUEST_TICKET_INCLUDE });
  if (!row) return undefined;
  return {
    id: row.id,
    title: row.title,
    details: row.details,
    sellerName: row.seller.legalName ?? row.location.label,
    place: { label: row.location.label, address: row.location.address, lat: row.location.lat, lng: row.location.lng },
    startsAt: row.startsAt.toISOString(),
    endsAt: row.endsAt.toISOString(),
    timezone: row.location.timezone,
    priceCents: row.priceCents,
    remaining: Math.max(0, row.quantity - row.sold),
    state: ticketState(row, now),
  };
}

export class PaymentsUnavailable extends Error {
  constructor() {
    super('Paying in the app is not available right now.');
  }
}

const NOT_ON_SALE: Record<Exclude<TicketState, 'on_sale'>, string> = {
  ended: 'This date has ended.',
  stopped: 'This date is no longer on sale.',
  sold_out: 'This date is sold out.',
};

/**
 * A hosted checkout URL for one ticket. Asking twice returns the same open
 * checkout rather than a second charge the guest could finish in another tab.
 */
export async function startTicketCheckout(input: { ticketId: string; userId: string; now?: Date }): Promise<{ url: string }> {
  const now = input.now ?? new Date();
  const stripe = stripeHandle.client();
  if (!stripe) throw new PaymentsUnavailable();

  const ticket = await db.vendorTicket.findFirst({
    where: { id: input.ticketId, ...LIVE_TICKET },
    include: {
      location: { select: { label: true } },
      seller: { select: { legalName: true, payoutReference: true, payoutStatus: true } },
    },
  });
  if (!ticket) throw new TicketRefused(['This ticket is not available.'], 404);
  const held = await db.vendorTicketOrder.findFirst({
    where: { ticketId: ticket.id, userId: input.userId, status: { in: ['settling', 'completed'] } },
    select: { id: true },
  });
  if (held) throw new TicketRefused(['You already have a ticket for this date. It is under My Requests.']);
  const state = ticketState(ticket, now);
  if (state !== 'on_sale') throw new TicketRefused([NOT_ON_SALE[state]]);
  if (ticket.seller.payoutStatus !== 'active' || !ticket.seller.payoutReference) {
    throw new TicketRefused(['This business cannot take payments in the app yet.']);
  }
  const destination = ticket.seller.payoutReference;

  const feeBps = await currentPlatformFeeBps(VENDOR_BOOKING_FEE_SCOPE, config.vendorBookingFeeBps);
  const { feeCents, sellerNetCents } = splitBookingAmount(ticket.priceCents, feeBps, config.vendorBookingFeeMinCents);

  const order = await serializableTransactionWithRetry(async (tx) => {
    await tx.vendorTicketOrder.updateMany({
      where: { ticketId: ticket.id, userId: input.userId, status: { in: OPEN_STATES }, expiresAt: { lte: now } },
      data: { status: 'expired' },
    });
    const open = await tx.vendorTicketOrder.findFirst({
      where: { ticketId: ticket.id, userId: input.userId, status: { in: OPEN_STATES }, expiresAt: { gt: now }, amountCents: ticket.priceCents },
      orderBy: { createdAt: 'desc' },
    });
    if (open) return open;
    return tx.vendorTicketOrder.create({
      data: {
        ticketId: ticket.id,
        sellerId: ticket.sellerId,
        userId: input.userId,
        destination,
        amountCents: ticket.priceCents,
        platformFeeBps: feeBps,
        platformFeeCents: feeCents,
        sellerNetCents,
        currency: 'usd',
        status: 'creating',
        expiresAt: new Date(now.getTime() + CHECKOUT_MINUTES * 60_000),
      },
    });
  }, 'Another payment for this ticket is starting. Try again.');

  if (order.status === 'pending' && order.checkoutUrl) return { url: order.checkoutUrl };

  const back = ticketUrl(ticket.id);
  const session = await stripe.checkout.sessions.create(
    {
      mode: 'payment',
      line_items: [
        {
          price_data: {
            currency: order.currency,
            unit_amount: order.amountCents,
            product_data: { name: ticket.title, description: `${ticket.seller.legalName ?? ticket.location.label} · ${ticket.location.label}` },
          },
          quantity: 1,
        },
      ],
      payment_intent_data: {
        application_fee_amount: order.platformFeeCents,
        transfer_data: { destination: order.destination },
        metadata: { kind: VENDOR_TICKET_KIND, orderId: order.id, ticketId: ticket.id },
      },
      metadata: { kind: VENDOR_TICKET_KIND, orderId: order.id, ticketId: ticket.id, userId: input.userId },
      expires_at: Math.floor(order.expiresAt.getTime() / 1000),
      custom_text: { submit: { message: 'Refunds after buying are handled by Bytspot support.' } },
      success_url: `${back}&checkout=ticket-paid&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${back}&checkout=ticket-cancelled`,
    },
    { idempotencyKey: `vendor-ticket-checkout-${order.id}` },
  );
  if (!session.url) throw new Error('Stripe Checkout did not return a hosted URL.');

  await db.vendorTicketOrder.updateMany({
    where: { id: order.id, status: 'creating' },
    data: { status: 'pending', stripeSessionId: session.id, checkoutUrl: session.url },
  });
  return { url: session.url };
}

export type SettledAs = 'completed' | 'refunded' | 'ignored';

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

class NotTaken extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}

/**
 * Turns a confirmed payment into a ticket, or gives the money back. Safe to run
 * more than once for one session: Stripe redelivers.
 */
export async function settleTicketCheckout(session: Stripe.Checkout.Session, stripe: Stripe): Promise<SettledAs> {
  const orderId = session.metadata?.orderId;
  if (!orderId) return 'ignored';
  const order = await db.vendorTicketOrder.findUnique({ where: { id: orderId } });
  if (!order) throw new Error('Ticket order was not found.');
  if (order.stripeSessionId && order.stripeSessionId !== session.id) throw new Error('Ticket order session mismatch.');
  if (order.status === 'completed') return 'completed';
  if (order.status === 'refunded') return 'refunded';

  const paymentIntentId = typeof session.payment_intent === 'string' ? session.payment_intent : session.payment_intent?.id ?? null;
  if (session.amount_total !== order.amountCents || session.currency?.toLowerCase() !== order.currency) {
    return refund(order, session.id, paymentIntentId, 'The amount paid did not match the ticket.', stripe);
  }

  // Claimed first, so the database's one-ticket-per-guest rule decides a
  // second payment for the same date before any capacity is taken.
  if (order.status !== 'settling') {
    try {
      const { count } = await db.vendorTicketOrder.updateMany({
        where: { id: order.id, status: { in: [...OPEN_STATES, 'expired'] } },
        data: { status: 'settling' },
      });
      if (count === 0) {
        const current = await db.vendorTicketOrder.findUnique({ where: { id: order.id }, select: { status: true } });
        if (current?.status === 'completed') return 'completed';
        if (current?.status !== 'settling') return 'refunded';
      }
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      return refund(order, session.id, paymentIntentId, 'You already had a ticket for this date.', stripe);
    }
  }

  for (let attempt = 0; ; attempt += 1) {
    try {
      await db.$transaction(async (tx) => {
        const taken = await tx.vendorTicket.updateMany({
          where: { id: order.ticketId, withdrawnAt: null, sold: { lt: db.vendorTicket.fields.quantity } },
          data: { sold: { increment: 1 } },
        });
        if (taken.count === 0) {
          const ticket = await tx.vendorTicket.findUnique({ where: { id: order.ticketId }, select: { withdrawnAt: true } });
          throw new NotTaken(ticket?.withdrawnAt ? 'This date stopped selling while you were paying.' : 'The last ticket went while you were paying.');
        }
        const { count } = await tx.vendorTicketOrder.updateMany({
          where: { id: order.id, status: 'settling' },
          data: { status: 'completed', completedAt: new Date(), stripeSessionId: session.id, paymentIntentId, passCode: newPassCode() },
        });
        if (count === 0) throw new NotTaken('');
      });
      break;
    } catch (error) {
      if (error instanceof NotTaken) {
        if (!error.reason) return 'completed';
        return refund(order, session.id, paymentIntentId, error.reason, stripe);
      }
      // A pass code that collided with another: draw a new one.
      if (isUniqueViolation(error) && attempt < 3) continue;
      throw error;
    }
  }
  return 'completed';
}

async function refund(order: VendorTicketOrder, sessionId: string, paymentIntentId: string | null, reason: string, stripe: Stripe): Promise<SettledAs> {
  if (!paymentIntentId) throw new Error('A paid ticket order has no payment to refund.');
  const refunded = await stripe.refunds.create(
    {
      payment_intent: paymentIntentId,
      reverse_transfer: true,
      refund_application_fee: true,
      metadata: { kind: VENDOR_TICKET_KIND, orderId: order.id },
    },
    { idempotencyKey: `vendor-ticket-refund-${order.id}` },
  );
  await db.vendorTicketOrder.updateMany({
    where: { id: order.id, status: { in: [...OPEN_STATES, 'expired', 'settling'] } },
    data: { status: 'refunded', refundId: refunded.id, refundReason: reason, stripeSessionId: sessionId, paymentIntentId },
  });
  void deliverPushNotification({
    userIds: [order.userId],
    category: 'reservations',
    title: 'You were refunded',
    body: `${reason} Your payment is on its way back.`,
    url: ticketUrl(order.ticketId),
    type: 'ticket-refunded',
  }).catch((err: any) => console.error('[vendor-ticket] refund notice failed:', err?.message));
  return 'refunded';
}

/**
 * Claims ticket events from the shared Stripe endpoint. False for anything
 * that is not ours; throwing means answer 500 and let Stripe retry.
 */
export async function applyTicketCheckoutEvent(event: Stripe.Event): Promise<boolean> {
  if (!event.type.startsWith('checkout.session.')) return false;
  const session = event.data.object as Stripe.Checkout.Session;
  if (session.metadata?.kind !== VENDOR_TICKET_KIND) return false;
  const orderId = session.metadata?.orderId;
  if (!orderId) {
    console.warn('[vendor-ticket] signed event without an order id', { eventType: event.type });
    return true;
  }
  if (event.type === 'checkout.session.expired') {
    await db.vendorTicketOrder.updateMany({ where: { id: orderId, status: { in: OPEN_STATES } }, data: { status: 'expired' } });
    return true;
  }
  if (event.type !== 'checkout.session.completed' && event.type !== 'checkout.session.async_payment_succeeded') return true;
  if (session.mode !== 'payment' || session.payment_status !== 'paid') return true;

  const stripe = stripeHandle.client();
  if (!stripe) throw new Error('Stripe is not configured.');
  await settleTicketCheckout(session, stripe);
  return true;
}

export interface MyTicketDto {
  orderId: string;
  ticketId: string;
  title: string;
  sellerName: string;
  place: string;
  startsAt: string;
  endsAt: string;
  timezone: string | null;
  priceCents: number;
  payment: 'paying' | 'paid' | 'refunded';
  refundReason?: string;
  /** The code shown at the door. Present once paid. */
  pass?: string;
  checkedIn: boolean;
}

/** A guest's tickets: upcoming and the last 30 days, soonest first. */
export async function myTickets(userId: string, now: Date = new Date()): Promise<MyTicketDto[]> {
  const rows = await db.vendorTicketOrder.findMany({
    where: {
      userId,
      OR: [{ status: { in: ['settling', 'completed', 'refunded'] } }, { status: { in: OPEN_STATES }, expiresAt: { gt: now } }],
      ticket: { endsAt: { gt: new Date(now.getTime() - 30 * 86_400_000) } },
    },
    include: { ticket: { include: GUEST_TICKET_INCLUDE } },
    orderBy: { createdAt: 'desc' },
    take: 100,
  });
  // The newest attempt per date speaks for it: a refund followed by a paid
  // retry is a ticket, not a refund.
  const byTicket = new Map<string, (typeof rows)[number]>();
  for (const row of rows) {
    const kept = byTicket.get(row.ticketId);
    if (!kept || (kept.status !== 'completed' && row.status === 'completed')) byTicket.set(row.ticketId, row);
  }
  return [...byTicket.values()]
    .sort((a, b) => a.ticket.startsAt.getTime() - b.ticket.startsAt.getTime())
    .map((row) => ({
      orderId: row.id,
      ticketId: row.ticketId,
      title: row.ticket.title,
      sellerName: row.ticket.seller.legalName ?? row.ticket.location.label,
      place: row.ticket.location.label,
      startsAt: row.ticket.startsAt.toISOString(),
      endsAt: row.ticket.endsAt.toISOString(),
      timezone: row.ticket.location.timezone,
      priceCents: row.amountCents,
      payment: row.status === 'completed' ? 'paid' : row.status === 'refunded' ? 'refunded' : 'paying',
      refundReason: row.status === 'refunded' ? (row.refundReason ?? undefined) : undefined,
      pass: row.status === 'completed' ? (row.passCode ?? undefined) : undefined,
      checkedIn: !!row.checkedInAt,
    }));
}
