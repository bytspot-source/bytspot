/**
 * Decisions a Bytspot admin makes about a business: create it and invite its
 * owner, pause it, lift the pause, or close it for good. Guest reads already
 * require an ACTIVE business, so a paused or closed one leaves every guest
 * screen the moment its state changes.
 */
import type { VendorSeller } from '@prisma/client';
import { db } from '../lib/db';
import { normalizeEmail } from '../lib/contactHash';
import { sellerCanTransition, type SellerState } from './contract';
import { userForInvite } from './team';

export class VendorDecisionRefused extends Error {
  constructor(readonly reason: string, readonly code: 'NOT_FOUND' | 'CONFLICT' | 'BAD_REQUEST') {
    super(reason);
  }
}

export const PAUSE_REASON_MAX = 500;

async function openSeller(sellerId: string): Promise<VendorSeller> {
  const seller = await db.vendorSeller.findUnique({ where: { id: sellerId } });
  if (!seller || seller.state === 'CLOSED') throw new VendorDecisionRefused('No such business.', 'NOT_FOUND');
  return seller;
}

export function cleanReason(reason: string | null | undefined): string | null {
  const trimmed = reason?.trim() ?? '';
  return trimmed ? trimmed.slice(0, PAUSE_REASON_MAX) : null;
}

/**
 * A live business is suspended. One not yet live loses its approval, so it
 * cannot go live when it finishes setting up; Approve is offered again.
 */
export async function pauseSeller(sellerId: string, actorId: string, reason: string | null, now: Date = new Date()): Promise<VendorSeller> {
  const seller = await openSeller(sellerId);
  if (seller.state === 'SUSPENDED') throw new VendorDecisionRefused('This business is already paused.', 'CONFLICT');
  const decision = { pausedAt: now, pausedByUserId: actorId, pausedReason: cleanReason(reason) };
  if (seller.state === 'ACTIVE') {
    // Conditional, so a pause that races another state change does nothing.
    const moved = await db.vendorSeller.updateMany({ where: { id: seller.id, state: 'ACTIVE' }, data: { state: 'SUSPENDED', ...decision } });
    if (moved.count !== 1) throw new VendorDecisionRefused('This business changed. Refresh and try again.', 'CONFLICT');
  } else {
    if (!seller.approvedAt) throw new VendorDecisionRefused('This business is not approved yet.', 'CONFLICT');
    await db.vendorSeller.updateMany({
      where: { id: seller.id, state: { in: ['DRAFT', 'PENDING'] } },
      data: { approvedAt: null, approvedByUserId: null, ...decision },
    });
  }
  return db.vendorSeller.findUniqueOrThrow({ where: { id: seller.id } });
}

/** Lifts a pause on a live business. Its approval was never removed. */
export async function restoreSeller(sellerId: string): Promise<VendorSeller> {
  const seller = await openSeller(sellerId);
  if (seller.state !== 'SUSPENDED') throw new VendorDecisionRefused('This business is not paused.', 'CONFLICT');
  if (!sellerCanTransition('SUSPENDED', 'ACTIVE')) throw new VendorDecisionRefused('This business cannot be restored.', 'CONFLICT');
  const moved = await db.vendorSeller.updateMany({
    where: { id: seller.id, state: 'SUSPENDED' },
    data: { state: 'ACTIVE', pausedAt: null, pausedByUserId: null, pausedReason: null },
  });
  if (moved.count !== 1) throw new VendorDecisionRefused('This business changed. Refresh and try again.', 'CONFLICT');
  return db.vendorSeller.findUniqueOrThrow({ where: { id: seller.id } });
}

/** What still needs this business. Closing is refused until each is done. */
export async function closeBlockers(sellerId: string, now: Date = new Date()): Promise<string[]> {
  const [offers, tickets, settling, payouts] = await Promise.all([
    db.offer.findMany({
      where: { sellerId, state: 'ACCEPTED', startsAt: { gt: new Date(now.getTime() - 24 * 60 * 60_000) } },
      select: { startsAt: true, durationMins: true },
    }),
    db.vendorTicketOrder.count({ where: { sellerId, status: { in: ['pending', 'settling', 'completed'] }, ticket: { endsAt: { gt: now } } } }),
    db.vendorTicketOrder.count({ where: { sellerId, status: 'settling' } }),
    db.partyPayoutTransfer.count({ where: { sellerId, status: { in: ['pending', 'held', 'failed'] } } }),
  ]);
  const bookings = offers.filter((offer) => offer.startsAt.getTime() + offer.durationMins * 60_000 > now.getTime()).length;
  const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;
  const blockers: string[] = [];
  if (bookings > 0) blockers.push(plural(bookings, 'upcoming booking', 'upcoming bookings'));
  if (tickets > 0) blockers.push(plural(tickets, 'ticket for an event that has not ended', 'tickets for events that have not ended'));
  if (settling > 0) blockers.push(plural(settling, 'ticket payment still settling', 'ticket payments still settling'));
  if (payouts > 0) blockers.push(plural(payouts, 'party payout not yet paid', 'party payouts not yet paid'));
  return blockers;
}

/** A typed business name, compared without case, extra spaces or the kind of apostrophe and quote marks. */
export function sameBusinessName(typed: string, name: string): boolean {
  const plain = (value: string) => value.normalize('NFKC').replace(/[\u2018\u2019\u02BC\u0060\u00B4]/g, "'")
    .replace(/[\u201C\u201D]/g, '"').replace(/\s+/g, ' ').trim().toLowerCase();
  return plain(typed) === plain(name);
}

/**
 * True when nothing ever happened with this business: no guest asked it, it
 * made no offer, sold no ticket, ran no party session, was paid nothing and
 * holds no bands or tags. Only then is deleting it outright safe.
 */
export async function sellerHasHistory(sellerId: string): Promise<boolean> {
  const counts = await Promise.all([
    db.offer.count({ where: { sellerId } }),
    db.vendorTicketOrder.count({ where: { sellerId } }),
    db.partySession.count({ where: { sellerId } }),
    db.partyPayoutTransfer.count({ where: { sellerId } }),
    db.demand.count({ where: { targetWindow: { sellerId } } }),
    db.vendorBand.count({ where: { sellerId } }),
    db.vendorPatch.count({ where: { sellerId } }),
    db.vendorBandVisit.count({ where: { sellerId } }),
  ]);
  return counts.some((count) => count > 0);
}

/**
 * Deletes a business. The typed name must match, so a misclick on the wrong
 * row cannot remove it. With no history (a test or mistaken sign-up) it is
 * removed outright, with its seats, places, windows and media, so the owner
 * can be invited again from scratch. Otherwise it is closed for good: past
 * bookings and payouts are kept, and its places stop being any venue's
 * business so the venue can be given to another one.
 */
export async function closeSeller(sellerId: string, actorId: string, confirmName: string, now: Date = new Date()): Promise<{ seller: VendorSeller; blockers: string[]; deleted: boolean }> {
  const seller = await openSeller(sellerId);
  const name = seller.legalName?.trim() || 'Unnamed business';
  if (!sameBusinessName(confirmName, name)) {
    throw new VendorDecisionRefused(`Type ${name} to confirm.`, 'BAD_REQUEST');
  }
  if (!sellerCanTransition(seller.state as SellerState, 'CLOSED')) throw new VendorDecisionRefused('This business cannot be closed.', 'CONFLICT');
  const blockers = await closeBlockers(seller.id, now);
  if (blockers.length > 0) return { seller, blockers, deleted: false };
  if (!(await sellerHasHistory(seller.id))) {
    await db.$transaction(async (tx) => {
      const removed = await tx.vendorSeller.deleteMany({ where: { id: seller.id, state: seller.state } });
      if (removed.count !== 1) throw new VendorDecisionRefused('This business changed. Refresh and try again.', 'CONFLICT');
    });
    return { seller, blockers: [], deleted: true };
  }
  const closed = await db.$transaction(async (tx) => {
    const moved = await tx.vendorSeller.updateMany({
      where: { id: seller.id, state: seller.state },
      data: { state: 'CLOSED', closedAt: now, closedByUserId: actorId },
    });
    if (moved.count !== 1) throw new VendorDecisionRefused('This business changed. Refresh and try again.', 'CONFLICT');
    await tx.vendorLocation.updateMany({ where: { sellerId: seller.id }, data: { menuVenueId: null } });
    return tx.vendorSeller.findUniqueOrThrow({ where: { id: seller.id } });
  });
  return { seller: closed, blockers: [], deleted: false };
}

/**
 * A business created from admin, with its owner invited by email. The owner
 * accepts by signing in to the console with that address and finishes setup
 * there, payout and all. Nothing here goes live without the usual approval.
 */
export async function createSellerWithOwner(input: { legalName: string; email: string }, actorId: string, now: Date = new Date()): Promise<{ seller: VendorSeller; email: string }> {
  const legalName = input.legalName.trim();
  const email = normalizeEmail(input.email);
  if (!legalName) throw new VendorDecisionRefused('Enter the business name.', 'BAD_REQUEST');
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new VendorDecisionRefused('Enter a valid email address.', 'BAD_REQUEST');
  const userId = await userForInvite(email);
  const duplicate = await db.vendorSeller.findFirst({
    where: { state: { not: 'CLOSED' }, legalName: { equals: legalName, mode: 'insensitive' }, seats: { some: { userId, role: 'owner' } } },
    select: { id: true },
  });
  if (duplicate) throw new VendorDecisionRefused('That person already owns a business with this name.', 'CONFLICT');
  const seller = await db.vendorSeller.create({
    data: {
      legalName,
      contactEmail: email,
      createdByUserId: actorId,
      seats: { create: { userId, role: 'owner', state: 'INVITED', invitedAt: now } },
    },
  });
  return { seller, email };
}

/** Sends the owner invite again with a fresh expiry, for an owner who never signed in. */
export async function renewOwnerInvite(sellerId: string, now: Date = new Date()): Promise<{ seller: VendorSeller; email: string }> {
  const seller = await openSeller(sellerId);
  const seat = await db.vendorSeat.findFirst({
    where: { sellerId: seller.id, role: 'owner', state: 'INVITED' },
    include: { user: { select: { email: true } } },
    orderBy: { createdAt: 'asc' },
  });
  if (!seat?.user.email) throw new VendorDecisionRefused('No owner invite is waiting.', 'CONFLICT');
  await db.vendorSeat.update({ where: { id: seat.id }, data: { invitedAt: now } });
  return { seller, email: seat.user.email };
}
