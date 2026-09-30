import { randomInt } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { db } from '../lib/db';
import { windowTemplate } from './windows';

/**
 * Bookings, passes and attendance.
 *
 * A booking is an accepted offer. The guest shows its pass code at the door,
 * and a seat with CHECK_IN records that they came or did not. Nothing about
 * attendance changes what was paid: refunds stay with the processor flow.
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

async function withGuestNames(rows: BookingRow[], now: Date): Promise<BookingDto[]> {
  const ids = [...new Set(rows.map((row) => row.demand.raisedByUserId))];
  const users = ids.length
    ? await db.user.findMany({ where: { id: { in: ids }, deletedAt: null }, select: { id: true, name: true } })
    : [];
  const names = new Map(users.map((user) => [user.id, firstName(user.name)]));
  return rows.map((row) => toBookingDto(row, names.get(row.demand.raisedByUserId), now));
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
  const rows = await db.offer.findMany({
    where: {
      sellerId: input.sellerId,
      state: 'ACCEPTED',
      ...scope,
      startsAt:
        input.when === 'upcoming'
          ? { gt: new Date(now.getTime() - 24 * 60 * 60_000) }
          : { gt: new Date(now.getTime() - 30 * 86_400_000), lte: now },
    },
    orderBy: { startsAt: input.when === 'upcoming' ? 'asc' : 'desc' },
    take: 200,
    include: bookingInclude,
  });
  const ended = (row: BookingRow) => row.startsAt.getTime() + row.durationMins * 60_000 <= now.getTime();
  const kept = rows.filter((row) => (input.when === 'upcoming' ? !ended(row) : ended(row)));
  return withGuestNames(kept.slice(0, 100), now);
}

/** The booking behind a pass at this business, or undefined. Other businesses' passes read as unknown. */
export async function findByPass(input: { sellerId: string; code: string; windowIds?: string[]; now?: Date }): Promise<BookingDto | undefined> {
  const row = await db.offer.findFirst({
    where: { sellerId: input.sellerId, passCode: input.code, ...(input.windowIds ? { windowId: { in: input.windowIds } } : {}) },
    include: bookingInclude,
  });
  if (!row) return undefined;
  const [dto] = await withGuestNames([row], input.now ?? new Date());
  return dto;
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
  if (!offer) throw new BookingNotFound();
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
