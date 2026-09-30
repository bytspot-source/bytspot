import { randomBytes } from 'crypto';
import bcrypt from 'bcryptjs';
import type { VendorSeat } from '@prisma/client';
import { db } from '../lib/db';
import { BOOKABLE_TEMPLATES, roleCapabilities, roleScope, type SeatRole, type SeatState } from './contract';

/**
 * Staff seats: invite, suspend, restore, remove.
 *
 * The same rules the console reads from bookable-templates.json, checked again
 * here because a client-side rule is a courtesy. Nobody hands out a seat equal
 * to or above their own, so a manager can never mint an owner, and the owner
 * seat is never removed.
 */

export type SeatOperationId = 'INVITE_SEAT' | 'ACCEPT_SEAT' | 'SUSPEND_SEAT' | 'RESTORE_SEAT' | 'REVOKE_SEAT';

const seats = (BOOKABLE_TEMPLATES.seller as unknown as {
  seats: {
    operations: { id: SeatOperationId; label: string; from: SeatState[]; to: SeatState }[];
    unrevocableRole: SeatRole;
    soleRole: SeatRole;
    inviteExpiryHours: number;
  };
}).seats;

const ROLES = (BOOKABLE_TEMPLATES.staffRoles as { id: SeatRole }[]).map((role) => role.id);

export const INVITE_EXPIRY_HOURS = seats.inviteExpiryHours;

export function isSeatRole(value: string): value is SeatRole {
  return (ROLES as string[]).includes(value);
}

/** The granter has to be able to act as the business and strictly outrank the target. */
export function canGrantRole(granter: SeatRole, target: SeatRole): boolean {
  const mine = new Set(roleCapabilities(granter));
  const theirs = roleCapabilities(target);
  if (!mine.has('SELL') || theirs.length === 0) return false;
  if (theirs.length >= mine.size) return false;
  return theirs.every((capability) => mine.has(capability));
}

export function grantableRoles(granter: SeatRole): SeatRole[] {
  return ROLES.filter((role) => canGrantRole(granter, role));
}

export type SeatMoveRefusal = 'forbidden' | 'self' | 'unrevocable' | 'illegal-state';

/** Why a seat may not be moved, or undefined when it may. */
export function seatMoveRefusal(input: {
  granter: Pick<VendorSeat, 'id' | 'role'>;
  target: Pick<VendorSeat, 'id' | 'role' | 'state'>;
  operation: SeatOperationId;
}): SeatMoveRefusal | undefined {
  const { granter, target, operation } = input;
  if (granter.id === target.id) return 'self';
  if (operation === 'REVOKE_SEAT' && target.role === seats.unrevocableRole) return 'unrevocable';
  if (!canGrantRole(granter.role as SeatRole, target.role as SeatRole)) return 'forbidden';
  const move = seats.operations.find((entry) => entry.id === operation);
  if (!move || operation === 'INVITE_SEAT' || operation === 'ACCEPT_SEAT') return 'forbidden';
  if (!move.from.includes(target.state as SeatState)) return 'illegal-state';
  return undefined;
}

export function seatMoveTarget(operation: SeatOperationId): SeatState | undefined {
  return seats.operations.find((entry) => entry.id === operation)?.to;
}

export function inviteExpired(seat: Pick<VendorSeat, 'state' | 'invitedAt'>, now: Date = new Date()): boolean {
  if (seat.state !== 'INVITED' || !seat.invitedAt) return false;
  return now.getTime() - seat.invitedAt.getTime() > INVITE_EXPIRY_HOURS * 3_600_000;
}

/**
 * What stops an invite, as the owner would read it. `known` is what the
 * business holds, so an assignment can only name its own places and bookables.
 */
export function inviteBlockers(input: {
  granter: SeatRole;
  role: string;
  locationIds: string[];
  bookableIds: string[];
  known: { locationIds: string[]; bookableIds: string[] };
}): string[] {
  if (!isSeatRole(input.role) || !canGrantRole(input.granter, input.role)) return ['Your role cannot hand out that seat'];
  const blockers: string[] = [];
  if (roleScope(input.role) === 'assigned' && input.locationIds.length + input.bookableIds.length === 0) {
    blockers.push('Pick at least one bookable for this person');
  }
  if (
    !input.locationIds.every((id) => input.known.locationIds.includes(id)) ||
    !input.bookableIds.every((id) => input.known.bookableIds.includes(id))
  ) {
    blockers.push('That is not one of your places or bookables');
  }
  return blockers;
}

export interface TeamSeatDto {
  id: string;
  personId: string;
  email: string;
  name?: string;
  role: SeatRole;
  state: SeatState;
  locationIds: string[];
  bookableIds: string[];
  invitedAt?: string;
  inviteExpired: boolean;
  you: boolean;
}

export async function listTeam(sellerId: string, viewerSeatId: string, now: Date = new Date()): Promise<TeamSeatDto[]> {
  const rows = await db.vendorSeat.findMany({
    where: { sellerId, state: { not: 'REVOKED' } },
    include: { user: { select: { email: true, name: true } } },
    orderBy: { createdAt: 'asc' },
  });
  return rows.map((seat) => ({
    id: seat.id,
    personId: seat.userId,
    email: seat.user.email,
    name: seat.user.name ?? undefined,
    role: seat.role as SeatRole,
    state: seat.state as SeatState,
    locationIds: seat.locationIds,
    bookableIds: seat.bookableIds,
    invitedAt: seat.invitedAt?.toISOString(),
    inviteExpired: inviteExpired(seat, now),
    you: seat.id === viewerSeatId,
  }));
}

/**
 * The account an invite lands on. A person new to Bytspot gets one with an
 * unusable password: they sign in to the console with the emailed code, and
 * the generated secret is never stored or shown.
 */
export async function userForInvite(email: string): Promise<string> {
  const existing = await db.user.findUnique({ where: { email }, select: { id: true } });
  if (existing) return existing.id;
  const password = await bcrypt.hash(randomBytes(32).toString('hex'), 12);
  try {
    const created = await db.user.create({ data: { email, password, ref: 'vendor-invite' }, select: { id: true } });
    return created.id;
  } catch {
    // Two invites for the same new address raced; the other one created it.
    const raced = await db.user.findUnique({ where: { email }, select: { id: true } });
    if (!raced) throw new Error('could not create an account for the invite');
    return raced.id;
  }
}

/**
 * Signing in with the code sent to the invited address is the invitee's
 * acceptance. Expired invites stay invited, and the console says so.
 */
export async function acceptInvites(userId: string, now: Date = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - INVITE_EXPIRY_HOURS * 3_600_000);
  const accepted = await db.vendorSeat.updateMany({
    where: { userId, state: 'INVITED', invitedAt: { gte: cutoff } },
    data: { state: 'ACTIVE' },
  });
  return accepted.count;
}
