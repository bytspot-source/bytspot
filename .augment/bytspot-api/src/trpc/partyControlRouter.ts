import { createHash, randomBytes } from 'crypto';
import { TRPCError } from '@trpc/server';
import { Prisma } from '@prisma/client';
import Stripe from 'stripe';
import { z } from 'zod';
import { config } from '../config';
import { db } from '../lib/db';
import { protectedProcedure, publicProcedure, rateLimitMiddleware, router } from './trpc';

const partyId = z.string().trim().min(1).max(128);
const guestStates = ['confirmed', 'approved', 'checked-in'] as const;
const passBaseUrl = 'https://bytspot.app/party-pass';
type DbClient = typeof db | Prisma.TransactionClient;

function passSecret(): string { return randomBytes(32).toString('base64url'); }
function passHash(secret: string): string { return createHash('sha256').update(secret).digest('hex'); }
function personalPassUrl(secret: string): string { return `${passBaseUrl}/${encodeURIComponent(secret)}`; }
function isConfirmed(status: string): boolean { return (guestStates as readonly string[]).includes(status); }

async function hostParty(partyIdValue: string, userId: string) {
  const party = await db.party.findFirst({ where: { id: partyIdValue, hostUserId: userId, status: 'published' } });
  if (!party) throw new TRPCError({ code: 'NOT_FOUND', message: 'Published Party not found.' });
  return party;
}

async function capacitySummary(client: DbClient, partyIdValue: string, capacity: number) {
  const grouped = await client.partyGuest.groupBy({ by: ['status'], where: { partyId: partyIdValue }, _count: { _all: true } });
  const counts = Object.fromEntries(grouped.map((row) => [row.status, row._count._all]));
  const confirmed = guestStates.reduce((sum, status) => sum + (counts[status] ?? 0), 0);
  return {
    capacity,
    confirmed,
    spacesRemaining: Math.max(capacity - confirmed, 0),
    pending: (counts.pending ?? 0) + (counts['pending-payment'] ?? 0),
    checkedIn: counts['checked-in'] ?? 0,
  };
}

async function requireCapacity(client: DbClient, partyIdValue: string, capacity: number) {
  await client.$queryRaw`SELECT "id" FROM "parties" WHERE "id" = ${partyIdValue} FOR UPDATE`;
  const summary = await capacitySummary(client, partyIdValue, capacity);
  if (summary.confirmed + summary.pending >= capacity) throw new TRPCError({ code: 'CONFLICT', message: 'This Party is at capacity.' });
}

async function issuePass(client: DbClient, partyIdValue: string, userId: string) {
  const secret = passSecret();
  await client.partyGuest.update({
    where: { partyId_userId: { partyId: partyIdValue, userId } },
    data: { attendeePassHash: passHash(secret), attendeePassIssuedAt: new Date() },
  });
  return personalPassUrl(secret);
}

function guestResponse(guest: { id: string; status: string; source: string; ticketTierName: string | null; checkedInAt: Date | null; createdAt: Date; user: { id: string; name: string | null; profileImage: string | null } }) {
  return {
    id: guest.id, status: guest.status, source: guest.source, ticketTierName: guest.ticketTierName,
    checkedInAt: guest.checkedInAt?.toISOString() ?? null, createdAt: guest.createdAt.toISOString(),
    person: { userId: guest.user.id, name: guest.user.name ?? 'Bytspot guest', profileImage: guest.user.profileImage },
  };
}

const creatorLinkKind = z.enum(['music', 'merch', 'website', 'social']);
const httpsUrl = z.string().url().refine((value) => new URL(value).protocol === 'https:', 'Creator links must use HTTPS.');
const tierRank: Record<string, number> = { green: 0, platinum: 1, black: 2 };

function ticketTier(party: { ticketTiers: Prisma.JsonValue }, name: string) {
  const parsed = z.array(z.object({ name: z.string(), priceCents: z.number().int().positive(), quantity: z.number().int().positive(), requiredMembershipTier: z.enum(['green', 'platinum', 'black']) })).safeParse(party.ticketTiers);
  const tier = parsed.success ? parsed.data.find((candidate) => candidate.name === name) : undefined;
  if (!tier) throw new TRPCError({ code: 'NOT_FOUND', message: 'Ticket tier not found.' });
  return tier;
}

async function requireMembership(userId: string, requiredTier: string) {
  const user = await db.user.findUnique({ where: { id: userId }, select: { email: true, membershipTier: true } });
  if (!user) throw new TRPCError({ code: 'NOT_FOUND', message: 'User not found.' });
  if ((tierRank[user.membershipTier] ?? -1) < (tierRank[requiredTier] ?? Number.MAX_SAFE_INTEGER)) {
    throw new TRPCError({ code: 'FORBIDDEN', message: `This Party requires ${requiredTier} membership.` });
  }
  return user;
}

export const partyInviteRouter = router({
  get: publicProcedure.input(z.object({ partyId })).query(async ({ input }) => {
    const party = await db.party.findFirst({
      where: { id: input.partyId, status: 'published' },
      include: { host: { select: { name: true } }, media: { where: { kind: 'cover', position: 0 }, select: { id: true } }, creatorLinks: { include: { creatorLink: true } } },
    });
    if (!party) throw new TRPCError({ code: 'NOT_FOUND', message: 'Party not found.' });
    const isPrivate = party.accessMode === 'private-approval';
    return {
      source: 'host-studio-party', id: party.id, title: party.title, inviteNote: party.tagline, hostName: party.host.name ?? 'Bytspot Host',
      scheduledDate: party.startsAt.toISOString(), locationLabel: isPrivate ? 'Location shared after approval' : party.venueName,
      locationDisclosure: isPrivate ? 'after-approval' : 'public', accessMode: party.accessMode, capacity: party.capacity,
      tier: party.requiredMembershipTier, heroImageURL: party.media[0] ? `https://bytspot-api.onrender.com/media/parties/${party.media[0].id}` : null,
      creatorLinks: party.creatorLinks.map((link) => ({ id: link.id, kind: link.creatorLink.kind, label: link.creatorLink.label, url: link.creatorLink.url })),
    };
  }),
});

export const partyRsvpRouter = router({
  create: protectedProcedure
    .use(rateLimitMiddleware({ windowMs: 60_000, max: 10, label: 'party-rsvp-create' }))
    .input(z.object({ partyId, idempotencyKey: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => db.$transaction(async (tx) => {
      const party = await tx.party.findFirst({ where: { id: input.partyId, status: 'published' } });
      if (!party) throw new TRPCError({ code: 'NOT_FOUND', message: 'Party not found.' });
      if (party.admissionPausedAt) throw new TRPCError({ code: 'CONFLICT', message: 'New RSVPs are paused.' });
      if (party.accessMode === 'paid-ticket') throw new TRPCError({ code: 'BAD_REQUEST', message: 'This Party requires a paid ticket.' });
      await requireMembership(ctx.user.userId, party.requiredMembershipTier);
      const existing = await tx.partyGuest.findUnique({ where: { partyId_userId: { partyId: party.id, userId: ctx.user.userId } } });
      if (existing) return { status: existing.status, attendeePassUrl: null as string | null };
      if (party.accessMode === 'private-approval') {
        const guest = await tx.partyGuest.create({ data: { partyId: party.id, userId: ctx.user.userId, source: 'approval-request', status: 'pending' } });
        return { status: guest.status, attendeePassUrl: null as string | null };
      }
      await requireCapacity(tx, party.id, party.capacity);
      const guest = await tx.partyGuest.create({ data: { partyId: party.id, userId: ctx.user.userId, source: 'rsvp', status: 'confirmed' } });
      const attendeePassUrl = await issuePass(tx, party.id, guest.userId);
      return { status: guest.status, attendeePassUrl };
    })),
});

export const partyTicketsRouter = router({
  createCheckout: protectedProcedure
    .use(rateLimitMiddleware({ windowMs: 60_000, max: 5, label: 'party-ticket-checkout' }))
    .input(z.object({ partyId, ticketTierName: z.string().trim().min(1).max(100), idempotencyKey: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      if (!config.stripeSecretKey || !config.stripeWebhookSecret) {
        throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'Paid Party tickets are not configured.' });
      }
      const party = await db.party.findFirst({ where: { id: input.partyId, status: 'published', accessMode: 'paid-ticket' } });
      if (!party) throw new TRPCError({ code: 'NOT_FOUND', message: 'Paid Party not found.' });
      if (party.admissionPausedAt) throw new TRPCError({ code: 'CONFLICT', message: 'New tickets are paused.' });
      const tier = ticketTier(party, input.ticketTierName);
      const user = await requireMembership(ctx.user.userId, tier.requiredMembershipTier);
      let existingCheckoutId: string | null = null;
      await db.$transaction(async (tx) => {
        const existing = await tx.partyGuest.findUnique({ where: { partyId_userId: { partyId: party.id, userId: ctx.user.userId } } });
        if (existing && existing.status !== 'pending-payment') throw new TRPCError({ code: 'CONFLICT', message: 'You already have a Party guest record.' });
        if (existing?.stripeCheckoutSessionId) existingCheckoutId = existing.stripeCheckoutSessionId;
        if (!existing) {
          await requireCapacity(tx, party.id, party.capacity);
          await tx.partyGuest.create({ data: { partyId: party.id, userId: ctx.user.userId, source: 'ticket', status: 'pending-payment', ticketTierName: tier.name } });
        }
      });
      const stripe = new Stripe(config.stripeSecretKey);
      if (existingCheckoutId) {
        const session = await stripe.checkout.sessions.retrieve(existingCheckoutId);
        if (session.url && session.status === 'open') return { url: session.url, status: 'pending-payment' as const };
        throw new TRPCError({ code: 'CONFLICT', message: 'A ticket checkout is already being processed.' });
      }
      try {
        const session = await stripe.checkout.sessions.create({
          mode: 'payment', customer_email: user.email, payment_method_types: ['card'],
          line_items: [{ price_data: { currency: 'usd', unit_amount: tier.priceCents, product_data: { name: `${party.title} — ${tier.name}` } }, quantity: 1 }],
          metadata: { purchaseType: 'party-ticket', partyId: party.id, userId: ctx.user.userId, ticketTierName: tier.name },
          success_url: `${config.frontendUrl}/party/${encodeURIComponent(party.id)}?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
          cancel_url: `${config.frontendUrl}/party/${encodeURIComponent(party.id)}?checkout=cancelled`,
        });
        if (!session.url) throw new Error('Stripe did not return a checkout URL.');
        await db.partyGuest.update({ where: { partyId_userId: { partyId: party.id, userId: ctx.user.userId } }, data: { stripeCheckoutSessionId: session.id } });
        return { url: session.url, status: 'pending-payment' as const };
      } catch (error) {
        await db.partyGuest.deleteMany({ where: { partyId: party.id, userId: ctx.user.userId, status: 'pending-payment', stripeCheckoutSessionId: null } });
        if (error instanceof TRPCError) throw error;
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Ticket checkout could not be started.' });
      }
    }),
});

export const partyPassRouter = router({
  resolve: protectedProcedure.input(z.object({ partyId })).query(async ({ ctx, input }) => {
    const party = await db.party.findFirst({ where: { id: input.partyId, status: 'published' } });
    if (!party) throw new TRPCError({ code: 'NOT_FOUND', message: 'Party not found.' });
    const guest = await db.partyGuest.findUnique({ where: { partyId_userId: { partyId: party.id, userId: ctx.user.userId } } });
    const action = isConfirmed(guest?.status ?? '') ? 'view-pass' : party.accessMode === 'paid-ticket' ? 'buy-ticket' : party.accessMode === 'private-approval' ? 'request-approval' : 'rsvp';
    return { partyId: party.id, action, guest: { status: guest?.status ?? 'none', accessGranted: isConfirmed(guest?.status ?? '') } };
  }),
  mine: protectedProcedure.input(z.object({ partyId })).query(async ({ ctx, input }) => {
    const guest = await db.partyGuest.findUnique({ where: { partyId_userId: { partyId: input.partyId, userId: ctx.user.userId } } });
    if (!guest || !isConfirmed(guest.status)) throw new TRPCError({ code: 'FORBIDDEN', message: 'A confirmed Party pass is required.' });
    const secret = passSecret();
    await db.partyGuest.update({ where: { id: guest.id }, data: { attendeePassHash: passHash(secret), attendeePassIssuedAt: new Date() } });
    return { partyId: input.partyId, status: guest.status, attendeePassUrl: personalPassUrl(secret) };
  }),
});

export const partyControlRouter = router({
  summary: protectedProcedure.input(z.object({ partyId })).query(async ({ ctx, input }) => {
    const party = await hostParty(input.partyId, ctx.user.userId);
    return { partyId: party.id, title: party.title, admissionPaused: Boolean(party.admissionPausedAt), ...(await capacitySummary(db, party.id, party.capacity)) };
  }),
  guests: protectedProcedure.input(z.object({ partyId, status: z.enum(['all', 'pending', 'confirmed', 'approved', 'checked-in', 'declined']).default('all') })).query(async ({ ctx, input }) => {
    await hostParty(input.partyId, ctx.user.userId);
    const guests = await db.partyGuest.findMany({ where: { partyId: input.partyId, ...(input.status === 'all' ? {} : { status: input.status }) }, include: { user: { select: { id: true, name: true, profileImage: true } } }, orderBy: [{ checkedInAt: 'desc' }, { createdAt: 'asc' }] });
    return { guests: guests.map(guestResponse) };
  }),
  setAdmissionPaused: protectedProcedure.input(z.object({ partyId, paused: z.boolean() })).mutation(async ({ ctx, input }) => {
    await hostParty(input.partyId, ctx.user.userId);
    await db.party.update({ where: { id: input.partyId }, data: { admissionPausedAt: input.paused ? new Date() : null } });
    return { paused: input.paused };
  }),
  decide: protectedProcedure.input(z.object({ partyId, guestId: partyId, decision: z.enum(['approved', 'declined']) })).mutation(async ({ ctx, input }) => db.$transaction(async (tx) => {
    const party = await tx.party.findFirst({ where: { id: input.partyId, hostUserId: ctx.user.userId, status: 'published' } });
    if (!party) throw new TRPCError({ code: 'NOT_FOUND', message: 'Published Party not found.' });
    const guest = await tx.partyGuest.findFirst({ where: { id: input.guestId, partyId: party.id } });
    if (!guest) throw new TRPCError({ code: 'NOT_FOUND', message: 'Guest not found.' });
    if (guest.status !== 'pending') throw new TRPCError({ code: 'CONFLICT', message: 'Only pending guests can be decided.' });
    if (input.decision === 'approved') await requireCapacity(tx, party.id, party.capacity);
    await tx.partyGuest.update({ where: { id: guest.id }, data: { status: input.decision } });
    const attendeePassUrl = input.decision === 'approved' ? await issuePass(tx, party.id, guest.userId) : null;
    return { status: input.decision, attendeePassUrl };
  })),
  checkIn: protectedProcedure.input(z.object({ partyId, attendeePassSecret: z.string().min(20).max(200) })).mutation(async ({ ctx, input }) => {
    await hostParty(input.partyId, ctx.user.userId);
    const guest = await db.partyGuest.findFirst({ where: { partyId: input.partyId, attendeePassHash: passHash(input.attendeePassSecret) } });
    if (!guest || !isConfirmed(guest.status)) throw new TRPCError({ code: 'NOT_FOUND', message: 'Valid confirmed attendee pass not found.' });
    if (guest.checkedInAt) throw new TRPCError({ code: 'CONFLICT', message: 'This attendee has already checked in.' });
    await db.partyGuest.update({ where: { id: guest.id }, data: { status: 'checked-in', checkedInAt: new Date() } });
    return { checkedIn: true, guestId: guest.id };
  }),
});

export const creatorLinksRouter = router({
  listMine: protectedProcedure.query(async ({ ctx }) => ({ links: await db.creatorLink.findMany({ where: { userId: ctx.user.userId }, orderBy: { kind: 'asc' } }) })),
  upsert: protectedProcedure.input(z.object({ kind: creatorLinkKind, url: httpsUrl, label: z.string().trim().min(1).max(80).optional() })).mutation(async ({ ctx, input }) => {
    return db.creatorLink.upsert({ where: { userId_kind: { userId: ctx.user.userId, kind: input.kind } }, create: { userId: ctx.user.userId, ...input }, update: { url: input.url, label: input.label } });
  }),
  selectForParty: protectedProcedure.input(z.object({ partyId, creatorLinkIds: z.array(partyId).max(4) })).mutation(async ({ ctx, input }) => {
    await hostParty(input.partyId, ctx.user.userId);
    const owned = await db.creatorLink.count({ where: { userId: ctx.user.userId, id: { in: input.creatorLinkIds } } });
    if (owned !== input.creatorLinkIds.length) throw new TRPCError({ code: 'FORBIDDEN', message: 'Only your Creator Links can be selected.' });
    await db.$transaction([db.partyCreatorLink.deleteMany({ where: { partyId: input.partyId } }), db.partyCreatorLink.createMany({ data: input.creatorLinkIds.map((creatorLinkId) => ({ partyId: input.partyId, creatorLinkId })) })]);
    return { selected: input.creatorLinkIds.length };
  }),
  recordClick: publicProcedure.input(z.object({ partyLinkId: partyId })).mutation(async ({ input }) => {
    const link = await db.partyCreatorLink.findUnique({ where: { id: input.partyLinkId } });
    if (!link) throw new TRPCError({ code: 'NOT_FOUND', message: 'Creator Link not found.' });
    await db.creatorLinkClick.create({ data: { creatorLinkId: link.creatorLinkId, partyLinkId: link.id } });
    return { recorded: true };
  }),
});