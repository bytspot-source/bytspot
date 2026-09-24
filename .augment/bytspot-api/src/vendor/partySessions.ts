import { z } from 'zod';
import { db } from '../lib/db';
import { validateSessions, type SessionDraft, type SessionIssue } from '../services/partySessions';

/**
 * Authoring the bottles-and-hours a Party sells.
 *
 * A session is supply, so it is written on the vendor rail and never by a
 * host through the Party console: a host selects supply, a vendor states it.
 * The Party names the audience this supply is sold to; it does not own it,
 * which is why nothing here reads the Party's hours or address.
 *
 * Who may attach to which Party is the whole question, and the answer is
 * narrow on purpose. A vendor may author on a Party whose host holds a live
 * seat at that same business. That is the launch segment exactly — the
 * promoter running the night is the business selling the tables — and it
 * refuses the case nobody has designed yet, where a third-party vendor hangs
 * a $900 table on a stranger's Party. Opening that up needs a grant the host
 * issues, and there is no such grant, so this does not pretend to have one.
 */

const MAX_SESSIONS_PER_PARTY = 40;

export const authorSessionInput = z.object({
  name: z.string().min(1).max(80),
  kind: z.enum(['table', 'after-hours']),
  startsAt: z.coerce.date(),
  endsAt: z.coerce.date(),
  /** Null is not "unknown": it states the session is held where the Party is. */
  venueName: z.string().min(1).max(120).nullish(),
  lat: z.number().min(-90).max(90).nullish(),
  lng: z.number().min(-180).max(180).nullish(),
  bottleCount: z.number().int().min(0).max(200),
  bottleTerms: z.enum(['included', 'minimum']),
  priceCents: z.number().int().min(0).max(10_000_000),
  quantity: z.number().int().min(1).max(500),
  requiredMembershipTier: z.enum(['green', 'black']).nullish(),
});
export type AuthorSessionInput = z.infer<typeof authorSessionInput>;

/** Refused with every complaint at once, so a vendor fixes a draft in one pass. */
export class SessionRefused extends Error {
  constructor(readonly issues: SessionIssue[]) {
    super('session refused');
  }
}

/** Distinct from a refusal: the Party is not one this business may sell into. */
export class SessionPartyNotFound extends Error {
  constructor() {
    super('no such party');
  }
}

/** Refused because units are already spoken for. */
export class SessionInUse extends Error {
  constructor(readonly blockers: string[]) {
    super('session in use');
  }
}

export interface VendorSessionDto {
  id: string;
  partyId: string;
  name: string;
  kind: string;
  startsAt: string;
  endsAt: string;
  venueName: string | null;
  lat: number | null;
  lng: number | null;
  bottleCount: number;
  bottleTerms: string;
  priceCents: number;
  quantity: number;
  /** The vendor's own number. It is never projected to a guest. */
  committed: number;
  requiredMembershipTier: string | null;
  position: number;
}

export function vendorSessionDto(row: {
  id: string; partyId: string; name: string; kind: string; startsAt: Date; endsAt: Date;
  venueName: string | null; lat: number | null; lng: number | null; bottleCount: number;
  bottleTerms: string; priceCents: number; quantity: number; committed: number;
  requiredMembershipTier: string | null; position: number;
}): VendorSessionDto {
  return {
    id: row.id,
    partyId: row.partyId,
    name: row.name,
    kind: row.kind,
    startsAt: row.startsAt.toISOString(),
    endsAt: row.endsAt.toISOString(),
    venueName: row.venueName,
    lat: row.lat,
    lng: row.lng,
    bottleCount: row.bottleCount,
    bottleTerms: row.bottleTerms,
    priceCents: row.priceCents,
    quantity: row.quantity,
    committed: row.committed,
    requiredMembershipTier: row.requiredMembershipTier,
    position: row.position,
  };
}

/**
 * The Party, if this business may sell into it.
 *
 * A Party the business has no claim on is not found rather than forbidden, so
 * a caller cannot probe ids to learn which Parties exist. A draft Party is
 * fair game — supply is arranged before the night is announced — but a
 * cancelled one is not.
 */
async function sellablePartyFor(sellerId: string, partyId: string) {
  const party = await db.party.findFirst({
    where: { id: partyId, status: { not: 'cancelled' } },
    select: { id: true, hostUserId: true },
  });
  if (!party) throw new SessionPartyNotFound();

  const hostSeat = await db.vendorSeat.findFirst({
    where: { sellerId, userId: party.hostUserId, state: 'ACTIVE' },
    select: { id: true },
  });
  if (!hostSeat) throw new SessionPartyNotFound();
  return party;
}

/** Everything this business sells on one Party, in floor order. */
export async function listPartySessions(sellerId: string, partyId: string): Promise<VendorSessionDto[]> {
  await sellablePartyFor(sellerId, partyId);
  const rows = await db.partySession.findMany({
    where: { partyId, sellerId },
    orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
  });
  return rows.map(vendorSessionDto);
}

/**
 * One session, validated against the same pure rules the console will show
 * and the database will hold.
 *
 * The draft is checked beside the sessions already on the Party rather than
 * alone, because the name collision it has to catch is with them.
 */
export async function authorPartySession(
  sellerId: string,
  partyId: string,
  input: AuthorSessionInput,
): Promise<VendorSessionDto> {
  await sellablePartyFor(sellerId, partyId);

  const existing = await db.partySession.findMany({
    where: { partyId },
    orderBy: [{ position: 'asc' }],
    select: { name: true, position: true },
  });
  if (existing.length >= MAX_SESSIONS_PER_PARTY) {
    throw new SessionRefused([{ index: null, field: 'quantity', message: 'This Party already sells as many sessions as Bytspot carries.' }]);
  }

  const draft: SessionDraft = {
    name: input.name,
    kind: input.kind,
    startsAt: input.startsAt,
    endsAt: input.endsAt,
    venueName: input.venueName ?? null,
    lat: input.lat ?? null,
    lng: input.lng ?? null,
    bottleCount: input.bottleCount,
    bottleTerms: input.bottleTerms,
    priceCents: input.priceCents,
    quantity: input.quantity,
    requiredMembershipTier: input.requiredMembershipTier ?? null,
  };

  const issues = validateSessions([draft]);
  // validateSessions only sees the drafts handed to it, so the collision with
  // sessions already on the floor is checked here. Reported against the new
  // session, because that is the one the vendor can still rename.
  if (existing.some((row) => row.name.trim().toLowerCase() === draft.name.trim().toLowerCase())) {
    issues.push({ index: 0, field: 'name', message: 'Two sessions cannot share a name.' });
  }
  if (issues.length) throw new SessionRefused(issues);

  const position = existing.reduce((highest, row) => Math.max(highest, row.position), -1) + 1;
  const row = await db.partySession.create({
    data: {
      partyId,
      sellerId,
      name: draft.name.trim(),
      kind: draft.kind,
      startsAt: draft.startsAt,
      endsAt: draft.endsAt,
      venueName: draft.venueName,
      lat: draft.lat,
      lng: draft.lng,
      bottleCount: draft.bottleCount,
      bottleTerms: draft.bottleTerms,
      priceCents: draft.priceCents,
      quantity: draft.quantity,
      requiredMembershipTier: draft.requiredMembershipTier,
      position,
    },
  });
  return vendorSessionDto(row);
}

/**
 * Withdrawing a session.
 *
 * Refused once a unit is spoken for, because a guest holding bottles must not
 * discover the session was withdrawn underneath them. The database refuses it
 * too, through the checkout's RESTRICT; this is the readable half of that
 * pair, and it also catches a unit committed without a checkout behind it.
 */
export async function withdrawPartySession(sellerId: string, sessionId: string): Promise<void> {
  const session = await db.partySession.findFirst({
    where: { id: sessionId, sellerId },
    select: { id: true, partyId: true, committed: true },
  });
  if (!session) throw new SessionPartyNotFound();
  await sellablePartyFor(sellerId, session.partyId);

  const claims = await db.partySessionClaim.count({
    where: { sessionId: session.id, state: { in: ['held', 'settled'] } },
  });
  if (session.committed > 0 || claims > 0) {
    throw new SessionInUse(['Someone is already holding this. Cancel their claim first.']);
  }
  await db.partySession.delete({ where: { id: session.id } });
}
