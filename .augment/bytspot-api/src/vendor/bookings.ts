import { randomInt } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { db } from '../lib/db';
import { windowTemplate } from './windows';

/**
 * Bookings, passes and attendance.
 *
 * A booking is an accepted offer, or a ticket a guest bought for one of the
 * business's dates. The guest shows its pass code at the door, and a seat with
 * CHECK_IN records that they came or did not. Nothing about attendance changes
 * what was paid: refunds stay with the processor flow.
 *
 * Tickets hang off no window, so a seat scoped to assigned windows sees none.
 * Bands, cards, fobs and table tags (see ./bands) find a guest's bookings here.
 */

/** No 0/O or 1/I, so a code read aloud or typed from a screen survives. */
const PASS_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
export const PASS_LENGTH = 8;
/** A QR pass carries this prefix so the scanner ignores unrelated codes. */
export const PASS_QR_PREFIX = 'BYTSPOT-PASS:';

/** Guests may be checked in this long before their time. */
export const CHECK_IN_EARLY_MINS = 120;

export function newPassCode(): string {
  let code = '';
  for (let i = 0; i < PASS_LENGTH; i += 1) code += PASS_ALPHABET[randomInt(PASS_ALPHABET.length)];
  return code;
}

/** Accepts a typed code (any case, spaces or dashes) or a scanned QR payload. */
export function normalizePassCode(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  let value = raw.trim().toUpperCase();
  if (value.startsWith(PASS_QR_PREFIX)) value = value.slice(PASS_QR_PREFIX.length);
  value = value.replace(/[\s-]/g, '');
  return /^[A-Z0-9]{8}$/.test(value) ? value : undefined;
}

export class BookingNotFound extends Error {
  constructor() {
    super('No such booking');
  }
}

export class BookingRefused extends Error {
  constructor(readonly blockers: string[]) {
    super('booking refused');
  }
}

export type BookingState = 'upcoming' | 'checked_in' | 'no_show' | 'past';
export type BookingOperation = 'CHECK_IN' | 'NO_SHOW';
/** The contract's PASS states that can be read from a booking. */
export type PassState = 'ISSUED' | 'ADMITTED' | 'EXPIRED' | 'REVOKED';

export interface AttendanceFacts {
  state: string;
  startsAt: Date;
  durationMins: number;
  checkedInAt: Date | null;
  noShowAt: Date | null;
}

export function bookingState(offer: AttendanceFacts, now: Date): BookingState {
  if (offer.checkedInAt) return 'checked_in';
  if (offer.noShowAt) return 'no_show';
  return offer.startsAt.getTime() + offer.durationMins * 60_000 > now.getTime() ? 'upcoming' : 'past';
}

export function passState(offer: AttendanceFacts, now: Date): PassState {
  if (offer.state !== 'ACCEPTED' || offer.noShowAt) return 'REVOKED';
  if (offer.checkedInAt) return 'ADMITTED';
  return bookingState(offer, now) === 'past' ? 'EXPIRED' : 'ISSUED';
}

/** Why an operation cannot run now, or undefined when it can. */
export function bookingOperationBlocker(operation: BookingOperation, offer: AttendanceFacts, now: Date): string | undefined {
  if (offer.state !== 'ACCEPTED') return 'This booking was cancelled';
  if (offer.checkedInAt) return 'Already checked in';
  if (offer.noShowAt) return 'Already marked as a no-show';
  const start = offer.startsAt.getTime();
  if (operation === 'CHECK_IN') {
    if (now.getTime() < start - CHECK_IN_EARLY_MINS * 60_000) return 'Too early. Check in opens 2 hours before the booking';
    if (now.getTime() > start + offer.durationMins * 60_000) return 'This booking has ended';
    return undefined;
  }
  return now.getTime() < start ? 'A guest can only be a no-show once their time has started' : undefined;
}

export interface BookingDto {
  id: string;
  /** A ticket the guest bought for one of the business's dates, or an accepted offer. */
  kind: 'booking' | 'ticket';
  title: string;
  where: string;
  locationId: string;
  windowId?: string;
  startsAt: string;
  durationMins: number;
  timezone?: string;
  partySize: number;
  /** First name only: enough to greet the guest, no more. */
  guestName?: string;
  note?: string;
  priceCents: number;
  payAt: 'venue' | 'bytspot';
  paid: 'paid' | 'refunded' | 'at_venue';
  state: BookingState;
  pass: PassState;
  checkedInAt?: string;
}

const bookingInclude = {
  location: { select: { label: true, timezone: true } },
  window: { select: { skuTemplateId: true, title: true, durationMins: true } },
  demand: { select: { partySize: true, note: true, raisedByUserId: true } },
  checkouts: { where: { status: { in: ['completed', 'refunded'] } }, orderBy: { createdAt: 'desc' }, take: 1, select: { status: true } },
} satisfies Prisma.OfferInclude;

/** The fields a booking is read from. Rows loaded with `bookingInclude` satisfy it. */
export interface BookingRow extends AttendanceFacts {
  id: string;
  skuTemplateId: string;
  locationId: string;
  windowId: string | null;
  priceCents: number;
  payAt: string;
  location: { label: string; timezone: string | null };
  window: { skuTemplateId: string; title: string | null; durationMins: number | null } | null;
  demand: { partySize: number; note: string | null; raisedByUserId: string };
  checkouts: { status: string }[];
}

export function firstName(name: string | null | undefined): string | undefined {
  const first = name?.trim().split(/\s+/)[0];
  return first ? first.slice(0, 40) : undefined;
}

export function toBookingDto(row: BookingRow, guestName: string | undefined, now: Date): BookingDto {
  const title =
    row.window?.title?.trim() ||
    (row.window && windowTemplate(row.window)?.title) ||
    windowTemplate({ skuTemplateId: row.skuTemplateId })?.title ||
    'Booking';
  const checkout = row.checkouts[0]?.status;
  return {
    id: row.id,
    kind: 'booking',
    title,
    where: row.location.label,
    locationId: row.locationId,
    windowId: row.windowId ?? undefined,
    startsAt: row.startsAt.toISOString(),
    durationMins: row.durationMins,
    timezone: row.location.timezone ?? undefined,
    partySize: row.demand.partySize,
    guestName,
    note: row.demand.note ?? undefined,
    priceCents: row.priceCents,
    payAt: row.payAt === 'bytspot' ? 'bytspot' : 'venue',
    paid: checkout === 'refunded' ? 'refunded' : checkout === 'completed' ? 'paid' : 'at_venue',
    state: bookingState(row, now),
    pass: passState(row, now),
    checkedInAt: row.checkedInAt?.toISOString(),
  };
}

async function guestNames(userIds: string[]): Promise<Map<string, string | undefined>> {
  const ids = [...new Set(userIds)];
  const users = ids.length
    ? await db.user.findMany({ where: { id: { in: ids }, deletedAt: null }, select: { id: true, name: true } })
    : [];
  return new Map(users.map((user) => [user.id, firstName(user.name)]));
}

async function withGuestNames(rows: BookingRow[], now: Date): Promise<BookingDto[]> {
  const names = await guestNames(rows.map((row) => row.demand.raisedByUserId));
  return rows.map((row) => toBookingDto(row, names.get(row.demand.raisedByUserId), now));
}

const ticketOrderInclude = {
  ticket: { select: { title: true, startsAt: true, endsAt: true, locationId: true, location: { select: { label: true, timezone: true } } } },
} satisfies Prisma.VendorTicketOrderInclude;

type TicketOrderRow = Prisma.VendorTicketOrderGetPayload<{ include: typeof ticketOrderInclude }>;

function ticketFacts(row: Pick<TicketOrderRow, 'status' | 'checkedInAt' | 'noShowAt'> & { ticket: { startsAt: Date; endsAt: Date } }): AttendanceFacts {
  return {
    state: row.status === 'completed' ? 'ACCEPTED' : 'CANCELLED',
    startsAt: row.ticket.startsAt,
    durationMins: Math.round((row.ticket.endsAt.getTime() - row.ticket.startsAt.getTime()) / 60_000),
    checkedInAt: row.checkedInAt,
    noShowAt: row.noShowAt,
  };
}

export function ticketOrderToBookingDto(row: TicketOrderRow, guestName: string | undefined, now: Date): BookingDto {
  const facts = ticketFacts(row);
  return {
    id: row.id,
    kind: 'ticket',
    title: row.ticket.title,
    where: row.ticket.location.label,
    locationId: row.ticket.locationId,
    startsAt: row.ticket.startsAt.toISOString(),
    durationMins: facts.durationMins,
    timezone: row.ticket.location.timezone ?? undefined,
    partySize: 1,
    guestName,
    priceCents: row.amountCents,
    payAt: 'bytspot',
    paid: row.status === 'refunded' ? 'refunded' : 'paid',
    state: bookingState(facts, now),
    pass: passState(facts, now),
    checkedInAt: row.checkedInAt?.toISOString(),
  };
}

async function ticketsWithGuestNames(rows: TicketOrderRow[], now: Date): Promise<BookingDto[]> {
  const names = await guestNames(rows.map((row) => row.userId));
  return rows.map((row) => ticketOrderToBookingDto(row, names.get(row.userId), now));
}

export type BookingsWhen = 'upcoming' | 'past';

export function bookingsWhen(raw: unknown): BookingsWhen {
  return raw === 'past' ? 'past' : 'upcoming';
}

/**
 * Upcoming: not yet ended, soonest first. Past: the last 30 days, newest first.
 * An assigned-scope seat passes the windows it may see.
 */
export async function listBookings(input: {
  sellerId: string;
  when: BookingsWhen;
  windowIds?: string[];
  now?: Date;
}): Promise<BookingDto[]> {
  const now = input.now ?? new Date();
  const scope = input.windowIds ? { windowId: { in: input.windowIds } } : {};
  const startsAt =
    input.when === 'upcoming'
      ? { gt: new Date(now.getTime() - 24 * 60 * 60_000) }
      : { gt: new Date(now.getTime() - 30 * 86_400_000), lte: now };
  const [rows, tickets] = await Promise.all([
    db.offer.findMany({
      where: { sellerId: input.sellerId, state: 'ACCEPTED', ...scope, startsAt },
      orderBy: { startsAt: input.when === 'upcoming' ? 'asc' : 'desc' },
      take: 200,
      include: bookingInclude,
    }),
    input.windowIds
      ? Promise.resolve([] as TicketOrderRow[])
      : db.vendorTicketOrder.findMany({
          where: { sellerId: input.sellerId, status: 'completed', ticket: { startsAt } },
          orderBy: { ticket: { startsAt: input.when === 'upcoming' ? 'asc' : 'desc' } },
          take: 200,
          include: ticketOrderInclude,
        }),
  ]);
  const ended = (row: BookingRow) => row.startsAt.getTime() + row.durationMins * 60_000 <= now.getTime();
  const kept = rows.filter((row) => (input.when === 'upcoming' ? !ended(row) : ended(row)));
  const keptTickets = tickets.filter((row) => (input.when === 'upcoming' ? row.ticket.endsAt > now : row.ticket.endsAt <= now));
  const merged = [...(await withGuestNames(kept.slice(0, 100), now)), ...(await ticketsWithGuestNames(keptTickets.slice(0, 100), now))];
  merged.sort((a, b) => (input.when === 'upcoming' ? a.startsAt.localeCompare(b.startsAt) : b.startsAt.localeCompare(a.startsAt)));
  return merged.slice(0, 100);
}

/** The booking behind a pass at this business, or undefined. Other businesses' passes read as unknown. */
export async function findByPass(input: { sellerId: string; code: string; windowIds?: string[]; now?: Date }): Promise<BookingDto | undefined> {
  const row = await db.offer.findFirst({
    where: { sellerId: input.sellerId, passCode: input.code, ...(input.windowIds ? { windowId: { in: input.windowIds } } : {}) },
    include: bookingInclude,
  });
  if (row) {
    const [dto] = await withGuestNames([row], input.now ?? new Date());
    return dto;
  }
  if (input.windowIds) return undefined;
  const ticket = await db.vendorTicketOrder.findFirst({
    where: { sellerId: input.sellerId, passCode: input.code },
    include: ticketOrderInclude,
  });
  if (!ticket) return undefined;
  const [dto] = await ticketsWithGuestNames([ticket], input.now ?? new Date());
  return dto;
}

/** How far ahead an NFC item finds its guest's bookings, so a guest early for tonight is not told they have none. */
export const BAND_LOOKAHEAD_HOURS = 12;

/** The most a tap lists at once. */
const HOLDINGS_SHOWN = 5;

/**
 * Everything an NFC item's guest holds for now at this business: tickets and
 * bookings that have not ended and start within the lookahead, at the item's
 * place. Bookings on the item's own rail (its domains) come first; within
 * those, one still to check in before one already checked in, so a second tap
 * reads as already checked in. An assigned-scope seat sees its windows only.
 */
export async function holdingsForGuest(input: {
  sellerId: string;
  userId: string;
  locationId?: string | null;
  domains?: readonly string[];
  windowIds?: string[];
  now?: Date;
}): Promise<BookingDto[]> {
  const now = input.now ?? new Date();
  const horizon = new Date(now.getTime() + BAND_LOOKAHEAD_HOURS * 3_600_000);
  const place = input.locationId ? { locationId: input.locationId } : {};
  const [offers, tickets] = await Promise.all([
    db.offer.findMany({
      where: {
        sellerId: input.sellerId,
        state: 'ACCEPTED',
        demand: { raisedByUserId: input.userId },
        startsAt: { lte: horizon, gt: new Date(now.getTime() - 30 * 86_400_000) },
        ...place,
        ...(input.windowIds ? { windowId: { in: input.windowIds } } : {}),
      },
      orderBy: { startsAt: 'asc' },
      take: 20,
      include: { ...bookingInclude, window: { select: { ...bookingInclude.window.select, domain: true } } },
    }),
    input.windowIds
      ? Promise.resolve([] as TicketOrderRow[])
      : db.vendorTicketOrder.findMany({
          where: { sellerId: input.sellerId, userId: input.userId, status: 'completed', ticket: { endsAt: { gt: now }, startsAt: { lte: horizon }, ...place } },
          orderBy: { ticket: { startsAt: 'asc' } },
          take: 10,
          include: ticketOrderInclude,
        }),
  ]);
  const open = offers.filter((row) => row.startsAt.getTime() + row.durationMins * 60_000 > now.getTime());
  const domains = input.domains ?? [];
  const onRail = new Set(open.filter((row) => row.window && domains.includes(row.window.domain)).map((row) => row.id));
  const all = [...(await withGuestNames(open, now)), ...(await ticketsWithGuestNames(tickets, now))];
  // Tickets carry no domain; they sit with the rail of events and nights out.
  const ticketsOnRail = domains.includes('events') || domains.includes('nightlife');
  const rank = (dto: BookingDto) =>
    (dto.kind === 'ticket' ? (ticketsOnRail ? 0 : 1) : onRail.has(dto.id) ? 0 : 1) * 3 + (dto.pass === 'ISSUED' ? 0 : dto.pass === 'ADMITTED' ? 1 : 2);
  all.sort((a, b) => rank(a) - rank(b) || a.startsAt.localeCompare(b.startsAt));
  return all.slice(0, HOLDINGS_SHOWN);
}

/** The guest, place and end of a paid ticket or accepted booking an NFC item is linked from. */
export interface LinkSource {
  userId: string;
  locationId: string;
  endsAt: Date;
}

export async function linkSource(input: { sellerId: string; bookingId: string; windowIds?: string[] }): Promise<LinkSource | undefined> {
  const offer = await db.offer.findFirst({
    where: { id: input.bookingId, sellerId: input.sellerId, state: 'ACCEPTED', ...(input.windowIds ? { windowId: { in: input.windowIds } } : {}) },
    select: { locationId: true, startsAt: true, durationMins: true, demand: { select: { raisedByUserId: true } } },
  });
  if (offer) {
    return { userId: offer.demand.raisedByUserId, locationId: offer.locationId, endsAt: new Date(offer.startsAt.getTime() + offer.durationMins * 60_000) };
  }
  if (input.windowIds) return undefined;
  const order = await db.vendorTicketOrder.findFirst({
    where: { id: input.bookingId, sellerId: input.sellerId, status: 'completed' },
    select: { userId: true, ticket: { select: { locationId: true, endsAt: true } } },
  });
  return order ? { userId: order.userId, locationId: order.ticket.locationId, endsAt: order.ticket.endsAt } : undefined;
}

export async function moveBooking(input: {
  sellerId: string;
  offerId: string;
  seatId: string;
  operation: BookingOperation;
  windowIds?: string[];
  now?: Date;
}): Promise<BookingDto> {
  const now = input.now ?? new Date();
  const where = { id: input.offerId, sellerId: input.sellerId, ...(input.windowIds ? { windowId: { in: input.windowIds } } : {}) };
  const offer = await db.offer.findFirst({ where, select: { demandId: true, state: true, startsAt: true, durationMins: true, checkedInAt: true, noShowAt: true } });
  if (!offer) {
    if (input.windowIds) throw new BookingNotFound();
    return moveTicket({ ...input, now });
  }
  const blocker = bookingOperationBlocker(input.operation, offer, now);
  if (blocker) throw new BookingRefused([blocker]);

  // Guarded on the facts just checked, so two doors scanning one pass record it once.
  await db.$transaction(async (tx) => {
    const moved = await tx.offer.updateMany({
      where: { ...where, state: 'ACCEPTED', checkedInAt: null, noShowAt: null },
      data: input.operation === 'CHECK_IN' ? { checkedInAt: now, checkedInBySeatId: input.seatId } : { noShowAt: now },
    });
    if (moved.count === 0) throw new BookingRefused(['Someone else just recorded this booking']);
    await tx.demandEvent.create({
      data: {
        demandId: offer.demandId,
        offerId: input.offerId,
        sellerId: input.sellerId,
        kind: input.operation === 'CHECK_IN' ? 'CHECKED_IN' : 'NO_SHOW',
        detail: { seatId: input.seatId },
      },
    });
  });

  const row = (await db.offer.findFirst({ where: { id: input.offerId }, include: bookingInclude }))!;
  const [dto] = await withGuestNames([row], now);
  return dto;
}

/** Checks in a ticket holder, or records that they did not come. Guarded like a booking. */
async function moveTicket(input: { sellerId: string; offerId: string; seatId: string; operation: BookingOperation; now: Date }): Promise<BookingDto> {
  const where = { id: input.offerId, sellerId: input.sellerId };
  const order = await db.vendorTicketOrder.findFirst({ where, include: ticketOrderInclude });
  if (!order) throw new BookingNotFound();
  const blocker = bookingOperationBlocker(input.operation, ticketFacts(order), input.now);
  if (blocker) throw new BookingRefused([blocker]);
  const moved = await db.vendorTicketOrder.updateMany({
    where: { ...where, status: 'completed', checkedInAt: null, noShowAt: null },
    data: input.operation === 'CHECK_IN' ? { checkedInAt: input.now, checkedInBySeatId: input.seatId } : { noShowAt: input.now },
  });
  if (moved.count === 0) throw new BookingRefused(['Someone else just recorded this booking']);
  const row = (await db.vendorTicketOrder.findFirst({ where, include: ticketOrderInclude }))!;
  const [dto] = await ticketsWithGuestNames([row], input.now);
  return dto;
}
