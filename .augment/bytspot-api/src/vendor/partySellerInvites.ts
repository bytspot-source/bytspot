import { Prisma, type PartySellerInviteState } from '@prisma/client';
import { config } from '../config';
import { db } from '../lib/db';
import { sendPartySellerInviteEmail } from '../lib/email';
import { deliverPushNotification } from '../services/notificationDelivery';
import { partyAlertUrl } from '../services/partyAlerts';
import { partyEndedAt } from '../trpc/partyRouter';

/**
 * A host asking a business to sell on their Party.
 *
 * The seat rule in vendor/partySessions stays the default: a business sells on
 * a Party whose host is on its team. This is the grant that rule was waiting
 * for. The host names the business, the business accepts, and only then may it
 * attach supply. Neither side joins the other's team, and the business still
 * states every price and unit itself.
 */

export const MAX_OPEN_INVITES_PER_PARTY = 10;
const OPEN: PartySellerInviteState[] = ['PENDING', 'ACCEPTED'];

export type InviteRefusal = 'NOT_FOUND' | 'CONFLICT' | 'BAD_REQUEST';

export class InviteRefused extends Error {
  constructor(readonly reason: InviteRefusal, message: string) {
    super(message);
  }
}

export interface HostInviteDto {
  id: string;
  sellerId: string;
  sellerName: string;
  state: PartySellerInviteState;
  note: string | null;
  createdAt: string;
  respondedAt: string | null;
  /** Sessions this business has on sale on the Party right now. */
  liveSessions: number;
}

export interface SellerInviteDto {
  id: string;
  state: PartySellerInviteState;
  note: string | null;
  createdAt: string;
  respondedAt: string | null;
  party: { id: string; title: string; startsAt: string; endsAt: string; venueName: string; hostName: string; ended: boolean };
  liveSessions: number;
  /** Completed table sales on this Party owed to this business, after fees. */
  owedCents: number;
}

const sellerName = (seller: { legalName: string | null }) => seller.legalName?.trim() || 'Unnamed business';
const hostName = (user: { name: string | null }) => user.name?.trim() || 'A Bytspot host';

function vendorConsoleUrl(): string {
  return config.corsOrigins.find((origin) => /^https:\/\/vendor\./.test(origin)) ?? 'https://vendor.bytspot.app';
}

function partyIsOver(party: { startsAt: Date; endsAt: Date | null; closedAt: Date | null }, now: Date): boolean {
  return party.closedAt !== null || partyEndedAt(party) <= now;
}

/** The host's own Party, or not found; a host cannot learn about anyone else's. */
async function hostParty(hostUserId: string, partyId: string) {
  const party = await db.party.findFirst({
    where: { id: partyId, hostUserId, status: { not: 'cancelled' } },
    select: { id: true, title: true, startsAt: true, endsAt: true, closedAt: true, venueName: true, host: { select: { name: true } } },
  });
  if (!party) throw new InviteRefused('NOT_FOUND', 'Party not found.');
  return party;
}

async function liveSessionCounts(partyId: string, sellerIds: string[]): Promise<Map<string, number>> {
  if (sellerIds.length === 0) return new Map();
  const rows = await db.partySession.groupBy({
    by: ['sellerId'],
    where: { partyId, sellerId: { in: sellerIds }, withdrawnAt: null },
    _count: { _all: true },
  });
  return new Map(rows.map((row) => [row.sellerId, row._count._all]));
}

function hostInviteDto(
  invite: { id: string; sellerId: string; state: PartySellerInviteState; note: string | null; createdAt: Date; respondedAt: Date | null; seller: { legalName: string | null } },
  liveSessions: number,
): HostInviteDto {
  return {
    id: invite.id,
    sellerId: invite.sellerId,
    sellerName: sellerName(invite.seller),
    state: invite.state,
    note: invite.note,
    createdAt: invite.createdAt.toISOString(),
    respondedAt: invite.respondedAt?.toISOString() ?? null,
    liveSessions,
  };
}

/**
 * Live businesses a host can ask, by business or place name. Businesses the
 * host is already on the team of are left out: those sell through the seat.
 */
export async function searchInvitableSellers(hostUserId: string, partyId: string, query: string) {
  await hostParty(hostUserId, partyId);
  const q = query.trim();
  if (q.length < 2) return { sellers: [] };

  const sellers = await db.vendorSeller.findMany({
    where: {
      state: 'ACTIVE',
      OR: [
        { legalName: { contains: q, mode: 'insensitive' } },
        { locations: { some: { state: 'ACTIVE', label: { contains: q, mode: 'insensitive' } } } },
      ],
      seats: { none: { userId: hostUserId, state: 'ACTIVE' } },
    },
    select: {
      id: true,
      legalName: true,
      locations: { where: { state: 'ACTIVE' }, select: { label: true }, orderBy: { createdAt: 'asc' }, take: 1 },
    },
    orderBy: { legalName: 'asc' },
    take: 10,
  });
  const invites = await db.partySellerInvite.findMany({
    where: { partyId, sellerId: { in: sellers.map((seller) => seller.id) } },
    select: { sellerId: true, state: true },
  });
  const stateBySeller = new Map(invites.map((invite) => [invite.sellerId, invite.state]));
  return {
    sellers: sellers.map((seller) => ({
      id: seller.id,
      name: sellerName(seller),
      place: seller.locations[0]?.label ?? null,
      invite: stateBySeller.get(seller.id) ?? null,
    })),
  };
}

/** Every business the host has asked, answered or not; cancelled and removed asks are history. */
export async function listHostInvites(hostUserId: string, partyId: string): Promise<{ invites: HostInviteDto[] }> {
  await hostParty(hostUserId, partyId);
  const invites = await db.partySellerInvite.findMany({
    where: { partyId, state: { in: ['PENDING', 'ACCEPTED', 'DECLINED'] } },
    include: { seller: { select: { legalName: true } } },
    orderBy: { createdAt: 'asc' },
  });
  const counts = await liveSessionCounts(partyId, invites.map((invite) => invite.sellerId));
  return { invites: invites.map((invite) => hostInviteDto(invite, counts.get(invite.sellerId) ?? 0)) };
}

export async function createHostInvite(
  hostUserId: string,
  input: { partyId: string; sellerId: string; note?: string | null },
  now = new Date(),
): Promise<HostInviteDto> {
  const party = await hostParty(hostUserId, input.partyId);
  if (partyIsOver(party, now)) throw new InviteRefused('CONFLICT', 'This party has ended.');

  const seller = await db.vendorSeller.findFirst({
    where: { id: input.sellerId, state: 'ACTIVE' },
    select: { id: true, legalName: true, contactEmail: true, seats: { where: { userId: hostUserId, state: 'ACTIVE' }, select: { id: true } } },
  });
  if (!seller) throw new InviteRefused('NOT_FOUND', 'That business is not taking requests on Bytspot.');
  if (seller.seats.length > 0) {
    throw new InviteRefused('BAD_REQUEST', `You are on the ${sellerName(seller)} team already, so you can add its tables directly.`);
  }

  const note = input.note?.trim() || null;
  const existing = await db.partySellerInvite.findUnique({
    where: { partyId_sellerId: { partyId: party.id, sellerId: seller.id } },
    include: { seller: { select: { legalName: true } } },
  });
  if (existing && OPEN.includes(existing.state)) {
    const counts = await liveSessionCounts(party.id, [seller.id]);
    return hostInviteDto(existing, counts.get(seller.id) ?? 0);
  }
  if (existing?.state === 'DECLINED') throw new InviteRefused('CONFLICT', `${sellerName(seller)} declined this party.`);

  const open = await db.partySellerInvite.count({ where: { partyId: party.id, state: { in: OPEN } } });
  if (open >= MAX_OPEN_INVITES_PER_PARTY) {
    throw new InviteRefused('CONFLICT', `A party can have ${MAX_OPEN_INVITES_PER_PARTY} sellers asked or selling at once. Cancel a request to ask another.`);
  }

  const reopened = { state: 'PENDING' as const, note, respondedAt: null, respondedByUserId: null };
  let invite;
  try {
    invite = existing
      ? await db.partySellerInvite.update({ where: { id: existing.id }, data: reopened, include: { seller: { select: { legalName: true } } } })
      : await db.partySellerInvite.create({ data: { partyId: party.id, sellerId: seller.id, note }, include: { seller: { select: { legalName: true } } } });
  } catch (err) {
    // Two taps raced to create the same ask; the one that landed is the answer.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      const landed = await db.partySellerInvite.findUnique({
        where: { partyId_sellerId: { partyId: party.id, sellerId: seller.id } },
        include: { seller: { select: { legalName: true } } },
      });
      if (landed) return hostInviteDto(landed, 0);
    }
    throw err;
  }

  if (seller.contactEmail) {
    void sendPartySellerInviteEmail(seller.contactEmail, {
      legalName: sellerName(seller),
      hostName: hostName(party.host),
      partyTitle: party.title,
      startsAt: party.startsAt,
      venueName: party.venueName,
      note,
      consoleUrl: vendorConsoleUrl(),
    });
  }
  return hostInviteDto(invite, 0);
}

/**
 * Withdraws an unanswered ask, or removes a business that accepted. Removal is
 * refused while it still has sessions on sale, because the business's tables
 * are its own and only it may take them down.
 */
export async function cancelHostInvite(hostUserId: string, input: { partyId: string; inviteId: string }): Promise<HostInviteDto> {
  await hostParty(hostUserId, input.partyId);
  const invite = await db.partySellerInvite.findFirst({
    where: { id: input.inviteId, partyId: input.partyId },
    include: { seller: { select: { legalName: true } } },
  });
  if (!invite) throw new InviteRefused('NOT_FOUND', 'Request not found.');

  const live = (await liveSessionCounts(input.partyId, [invite.sellerId])).get(invite.sellerId) ?? 0;
  if (invite.state === 'PENDING' || invite.state === 'ACCEPTED') {
    if (invite.state === 'ACCEPTED' && live > 0) {
      throw new InviteRefused('CONFLICT', `${sellerName(invite.seller)} still has tables on this party. Ask them to withdraw those first.`);
    }
    const next = invite.state === 'PENDING' ? 'CANCELLED' : 'REMOVED';
    const moved = await db.partySellerInvite.updateMany({ where: { id: invite.id, state: invite.state }, data: { state: next } });
    if (moved.count === 0) throw new InviteRefused('CONFLICT', 'The business answered while you were changing this. Refresh and try again.');
    return hostInviteDto({ ...invite, state: next }, live);
  }
  return hostInviteDto(invite, live);
}

/** Asks this business has open, soonest Party first. */
export async function listSellerInvites(sellerId: string, now = new Date()): Promise<{ invites: SellerInviteDto[] }> {
  const invites = await db.partySellerInvite.findMany({
    where: { sellerId, state: { in: OPEN }, party: { status: { not: 'cancelled' } } },
    include: {
      party: { select: { id: true, title: true, startsAt: true, endsAt: true, closedAt: true, venueName: true, host: { select: { name: true } } } },
    },
    orderBy: { party: { startsAt: 'asc' } },
  });
  const partyIds = invites.map((invite) => invite.partyId);
  const [sessions, owed] = invites.length === 0 ? [[], []] : await Promise.all([
    db.partySession.groupBy({
      by: ['partyId'],
      where: { sellerId, partyId: { in: partyIds }, withdrawnAt: null },
      _count: { _all: true },
    }),
    db.partyCheckout.groupBy({
      by: ['partyId'],
      where: { sellerId, partyId: { in: partyIds }, status: 'completed' },
      _sum: { sellerNetCents: true },
    }),
  ]);
  const liveByParty = new Map(sessions.map((row) => [row.partyId, row._count._all]));
  const owedByParty = new Map(owed.map((row) => [row.partyId, row._sum.sellerNetCents ?? 0]));
  return {
    invites: invites.map((invite) => ({
      id: invite.id,
      state: invite.state,
      note: invite.note,
      createdAt: invite.createdAt.toISOString(),
      respondedAt: invite.respondedAt?.toISOString() ?? null,
      party: {
        id: invite.party.id,
        title: invite.party.title,
        startsAt: invite.party.startsAt.toISOString(),
        endsAt: partyEndedAt(invite.party).toISOString(),
        venueName: invite.party.venueName,
        hostName: hostName(invite.party.host),
        ended: partyIsOver(invite.party, now),
      },
      liveSessions: liveByParty.get(invite.partyId) ?? 0,
      owedCents: owedByParty.get(invite.partyId) ?? 0,
    })),
  };
}

/**
 * The business answers. Accepting is the grant; declining after accepting is
 * leaving, and is refused while its tables are still on sale.
 */
export async function respondToInvite(
  sellerId: string,
  userId: string,
  inviteId: string,
  answer: 'accept' | 'decline',
  now = new Date(),
): Promise<{ id: string; state: PartySellerInviteState }> {
  const invite = await db.partySellerInvite.findFirst({
    where: { id: inviteId, sellerId },
    include: {
      seller: { select: { legalName: true } },
      party: { select: { id: true, title: true, hostUserId: true, status: true, startsAt: true, endsAt: true, closedAt: true } },
    },
  });
  if (!invite || invite.party.status === 'cancelled') throw new InviteRefused('NOT_FOUND', 'Request not found.');

  if (answer === 'accept') {
    if (invite.state === 'ACCEPTED') return { id: invite.id, state: invite.state };
    if (invite.state !== 'PENDING') throw new InviteRefused('CONFLICT', invite.state === 'DECLINED' ? 'You declined this party.' : 'The host withdrew this request.');
    if (partyIsOver(invite.party, now)) throw new InviteRefused('CONFLICT', 'This party has ended.');
  } else {
    if (invite.state === 'DECLINED') return { id: invite.id, state: invite.state };
    if (invite.state !== 'PENDING' && invite.state !== 'ACCEPTED') throw new InviteRefused('CONFLICT', 'The host withdrew this request.');
    if (invite.state === 'ACCEPTED') {
      const live = await db.partySession.count({ where: { partyId: invite.partyId, sellerId, withdrawnAt: null } });
      if (live > 0) throw new InviteRefused('CONFLICT', 'Withdraw your sessions on this party before leaving it.');
    }
  }

  const next = answer === 'accept' ? 'ACCEPTED' : 'DECLINED';
  const moved = await db.partySellerInvite.updateMany({
    where: { id: invite.id, state: invite.state },
    data: { state: next, respondedAt: now, respondedByUserId: userId },
  });
  if (moved.count === 0) throw new InviteRefused('CONFLICT', 'The host changed this request. Refresh and try again.');

  void deliverPushNotification({
    userIds: [invite.party.hostUserId],
    category: 'party',
    title: answer === 'accept' ? `${sellerName(invite.seller)} accepted` : `${sellerName(invite.seller)} declined`,
    body: answer === 'accept'
      ? `They can now add tables to ${invite.party.title}.`
      : `They will not sell at ${invite.party.title}.`,
    url: partyAlertUrl(invite.party.id),
    type: 'party_seller_invite',
  });
  return { id: invite.id, state: next };
}
