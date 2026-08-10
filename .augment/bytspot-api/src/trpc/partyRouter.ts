import { randomBytes } from 'crypto';
import { TRPCError } from '@trpc/server';
import { Prisma } from '@prisma/client';
import Stripe from 'stripe';
import { z } from 'zod';
import { config } from '../config';
import { db } from '../lib/db';
import { getRedis } from '../lib/redis';
import { protectedProcedure, publicProcedure, rateLimitMiddleware, router } from './trpc';

const maxMediaBytes = 600_000;
const maxAlbumImages = 6;
const partyKinds = ['listening-party', 'comedy-night', 'premiere', 'private-party', 'fan-meetup', 'release-party', 'pop-up'] as const;
const templateConfigKinds = [...partyKinds, 'standard'] as const;
const accessModes = ['free-rsvp', 'paid-ticket', 'private-approval'] as const;
const tiers = ['green', 'platinum', 'black'] as const;
const hostRoles = ['cohost', 'door', 'finance'] as const;
const locationDisclosures = ['public', 'after-approval', 'withheld'] as const;
const httpsUrl = z.string().url().refine((value) => new URL(value).protocol === 'https:', 'Official destinations must use HTTPS.');
const ticketTierInput = z.object({ name: z.string().trim().min(1).max(100), priceCents: z.number().int().min(0).max(10_000_000), quantity: z.number().int().min(1).max(10_000), requiredMembershipTier: z.enum(tiers) });
const hostDestinationsInput = z.object({
  musicUrl: httpsUrl.optional(),
  merchUrl: httpsUrl.optional(),
  websiteUrl: httpsUrl.optional(),
  primarySocial: z.object({ platform: z.string().trim().min(1).max(40), url: httpsUrl }),
});

const draftInput = z.object({
  idempotencyKey: z.string().uuid(),
  templateId: z.enum(partyKinds),
  title: z.string().trim().min(3).max(140),
  tagline: z.string().trim().max(280),
  startsAt: z.string().datetime({ offset: true }),
  venueName: z.string().trim().min(1).max(200),
  locationDisclosure: z.enum(locationDisclosures).default('public'),
  capacity: z.number().int().min(2).max(10_000),
  accessMode: z.enum(accessModes),
  requiredMembershipTier: z.enum(tiers),
  hostDestinations: hostDestinationsInput,
  audienceCircleIds: z.array(z.string().min(1).max(128)).max(100),
  itinerary: z.array(z.object({ title: z.string().trim().min(1).max(160), offsetMinutes: z.number().int().min(0).max(10_080) })).max(30),
  ticketTiers: z.array(ticketTierInput).max(10),
  cohosts: z.array(z.object({ email: z.string().email().max(255), role: z.enum(hostRoles) })).max(20),
  templateConfig: z.object({ kind: z.enum(templateConfigKinds) }).passthrough(),
  source: z.literal('host-studio'),
}).superRefine((input, ctx) => {
  const allowsStandardConfig = input.templateId === 'comedy-night' || input.templateId === 'premiere';
  if (input.templateConfig.kind === 'standard' && !allowsStandardConfig) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['templateConfig', 'kind'], message: 'Standard configuration is only valid for Comedy Night and Premiere Parties.' });
  } else if (input.templateConfig.kind !== 'standard' && input.templateConfig.kind !== input.templateId) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['templateConfig', 'kind'], message: 'Template configuration must match the Party template.' });
  }
  if (input.templateId === 'private-party' && input.accessMode !== 'private-approval') {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['accessMode'], message: 'Private Parties require approval access.' });
  }
  if (input.locationDisclosure === 'after-approval' && input.accessMode !== 'private-approval') {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['accessMode'], message: 'Locations revealed after approval require approval access.' });
  }
  if (input.templateConfig.kind === 'pop-up' && input.templateConfig.locationDisclosure !== 'public' && input.locationDisclosure === 'public') {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['locationDisclosure'], message: 'Protected Pop-Up locations cannot be public.' });
  }
  const hasPaidTier = input.ticketTiers.some((tier) => tier.priceCents > 0);
  if (input.accessMode === 'paid-ticket' && !hasPaidTier) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['ticketTiers'], message: 'Paid Parties need a paid ticket tier.' });
  }
  if (input.accessMode !== 'paid-ticket' && hasPaidTier) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['ticketTiers'], message: 'Only paid Parties can include paid ticket tiers.' });
  }
});

const mediaInput = z.object({
  partyId: z.string().min(1),
  kind: z.enum(['cover', 'album']),
  index: z.number().int().min(0).max(maxAlbumImages - 1).optional(),
  dataUri: z.string().max(900_000),
}).superRefine((input, ctx) => {
  if (input.kind === 'album' && input.index === undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['index'], message: 'Album images require an index.' });
  }
  if (input.kind === 'cover' && input.index !== undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['index'], message: 'Cover images cannot specify an index.' });
  }
});

function partyShareUrl(id: string): string {
  return `${config.partyShareBaseUrl}/party/${encodeURIComponent(id)}`;
}

function partyMediaUrl(id: string): string {
  return `${config.publicApiUrl}/media/parties/${encodeURIComponent(id)}`;
}

function parseImageDataUri(dataUri: string): { bytes: Buffer; mimeType: string } {
  const match = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(dataUri);
  if (!match) throw new TRPCError({ code: 'BAD_REQUEST', message: 'Party media must be a JPEG, PNG, or WebP data URI.' });
  const bytes = Buffer.from(match[2], 'base64');
  if (bytes.length === 0 || bytes.length > maxMediaBytes) {
    throw new TRPCError({ code: 'PAYLOAD_TOO_LARGE', message: 'Party media must be no larger than 600 KB.' });
  }
  if (bytes.toString('base64') !== match[2] || !hasImageSignature(bytes, match[1])) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'Party media bytes do not match the declared image type.' });
  }
  return { bytes, mimeType: match[1] };
}

function hasImageSignature(bytes: Buffer, mimeType: string): boolean {
  if (mimeType === 'image/jpeg') return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (mimeType === 'image/png') return bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  return bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP';
}

function newPassCode(): string {
  return `BYT-${randomBytes(5).toString('hex').toUpperCase()}`;
}

function isUniqueConstraint(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === 'P2002';
}

type PartyContent = Pick<Prisma.PartyUncheckedCreateInput,
  'templateId' | 'title' | 'tagline' | 'startsAt' | 'venueName' | 'locationDisclosure' | 'capacity' | 'accessMode' |
  'requiredMembershipTier' | 'hostDestinations' | 'audienceCircleIds' | 'itinerary' | 'ticketTiers' | 'cohosts' | 'templateConfig'>;

function partyContent(input: z.infer<typeof draftInput>): PartyContent {
  return {
    templateId: input.templateId, title: input.title, tagline: input.tagline, startsAt: new Date(input.startsAt), venueName: input.venueName, locationDisclosure: input.locationDisclosure,
    capacity: input.capacity, accessMode: input.accessMode, requiredMembershipTier: input.requiredMembershipTier,
    hostDestinations: input.hostDestinations as Prisma.InputJsonValue, audienceCircleIds: input.audienceCircleIds, itinerary: input.itinerary, ticketTiers: input.ticketTiers,
    cohosts: input.cohosts, templateConfig: input.templateConfig as Prisma.InputJsonValue,
  };
}

async function refreshDraftContent(partyId: string, userId: string, input: z.infer<typeof draftInput>): Promise<void> {
  const updated = await db.party.updateMany({
    where: { id: partyId, hostUserId: userId, status: 'draft' },
    data: partyContent(input),
  });
  if (updated.count === 1) return;

  const party = await db.party.findFirst({ where: { id: partyId, hostUserId: userId } });
  if (!party) throw new TRPCError({ code: 'NOT_FOUND', message: 'Party draft not found.' });
  if (party.status !== 'published') throw new TRPCError({ code: 'CONFLICT', message: 'Party cannot be updated from its current state.' });
}

async function mutateDraftMedia<T>(
  partyId: string,
  userId: string,
  mutation: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T | null> {
  return db.$transaction(async (tx) => {
    const lockedDraft = await tx.party.updateMany({
      where: { id: partyId, hostUserId: userId, status: 'draft' },
      data: { updatedAt: new Date() },
    });
    if (lockedDraft.count === 1) return mutation(tx);

    const party = await tx.party.findFirst({ where: { id: partyId, hostUserId: userId } });
    if (!party) throw new TRPCError({ code: 'NOT_FOUND', message: 'Party draft not found.' });
    if (party.status === 'published') return null;
    throw new TRPCError({ code: 'CONFLICT', message: 'Party cannot be changed from its current state.' });
  });
}

export const partyDraftsRouter = router({
  create: protectedProcedure
    .use(rateLimitMiddleware({ windowMs: 60_000, max: 10, label: 'party-draft-create' }))
    .input(draftInput)
    .mutation(async ({ ctx, input }) => {
      const existing = await db.party.findUnique({ where: { hostUserId_idempotencyKey: { hostUserId: ctx.user.userId, idempotencyKey: input.idempotencyKey } } });
      if (existing) {
        await refreshDraftContent(existing.id, ctx.user.userId, input);
        return { id: existing.id };
      }
      try {
        const party = await db.party.create({
          data: {
            hostUserId: ctx.user.userId, idempotencyKey: input.idempotencyKey,
            ...partyContent(input),
          },
        });
        return { id: party.id };
      } catch (error) {
        if (!isUniqueConstraint(error)) throw error;
        const concurrent = await db.party.findUnique({ where: { hostUserId_idempotencyKey: { hostUserId: ctx.user.userId, idempotencyKey: input.idempotencyKey } } });
        if (concurrent) {
          await refreshDraftContent(concurrent.id, ctx.user.userId, input);
          return { id: concurrent.id };
        }
        throw error;
      }
    }),
});

export const partyMediaRouter = router({
  reset: protectedProcedure
    .input(z.object({ partyId: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      const deleted = await mutateDraftMedia(input.partyId, ctx.user.userId, (tx) => tx.partyMedia.deleteMany({ where: { partyId: input.partyId } }));
      return { status: deleted === null ? 'published' as const : 'ready' as const };
    }),
  upload: protectedProcedure
    .use(rateLimitMiddleware({ windowMs: 60_000, max: 12, label: 'party-media-upload' }))
    .input(mediaInput)
    .mutation(async ({ ctx, input }) => {
      const { bytes, mimeType } = parseImageDataUri(input.dataUri);
      const imageBytes = Uint8Array.from(bytes);
      const position = input.kind === 'cover' ? 0 : input.index!;
      const media = await mutateDraftMedia(input.partyId, ctx.user.userId, (tx) => tx.partyMedia.upsert({
        where: { partyId_kind_position: { partyId: input.partyId, kind: input.kind, position } },
        create: { partyId: input.partyId, kind: input.kind, position, mimeType, bytes: imageBytes, byteSize: imageBytes.length },
        update: { mimeType, bytes: imageBytes, byteSize: imageBytes.length },
      }));
      if (media === null) {
        const existing = await db.partyMedia.findUnique({ where: { partyId_kind_position: { partyId: input.partyId, kind: input.kind, position } } });
        if (!existing) throw new TRPCError({ code: 'CONFLICT', message: 'Published Party media cannot be changed.' });
        return { url: partyMediaUrl(existing.id) };
      }
      return { url: partyMediaUrl(media.id) };
    }),
});

export const partyPublish = protectedProcedure
  .use(rateLimitMiddleware({ windowMs: 60_000, max: 10, label: 'party-publish' }))
  .input(z.object({ partyId: z.string().min(1), idempotencyKey: z.string().uuid() }))
  .mutation(async ({ ctx, input }) => {
    const party = await db.party.findFirst({ where: { id: input.partyId, hostUserId: ctx.user.userId } });
    if (!party) throw new TRPCError({ code: 'NOT_FOUND', message: 'Party draft not found.' });
    if (party.idempotencyKey !== input.idempotencyKey) throw new TRPCError({ code: 'CONFLICT', message: 'The publish request does not match this Party draft.' });
    if (party.status === 'published' && party.passCode) return { id: party.id, shareUrl: partyShareUrl(party.id), passCode: party.passCode };
    if (party.status !== 'draft') throw new TRPCError({ code: 'CONFLICT', message: 'Party cannot be published from its current state.' });
    const shareUrl = partyShareUrl(party.id);
    const redis = getRedis();
    if (redis) {
      const cached = await redis.get(`idem:party-publish:${ctx.user.userId}:${input.idempotencyKey}`).catch(() => null);
      if (cached) return JSON.parse(cached) as { id: string; shareUrl: string; passCode: string };
    }
    for (let attempt = 0; attempt < 3; attempt++) {
      const result = { id: party.id, shareUrl, passCode: newPassCode() };
      try {
        const published = await db.party.updateMany({
          where: { id: party.id, hostUserId: ctx.user.userId, status: 'draft' },
          data: { status: 'published', passCode: result.passCode, publishedAt: new Date() },
        });
        if (published.count === 1) {
          if (redis) redis.set(`idem:party-publish:${ctx.user.userId}:${input.idempotencyKey}`, JSON.stringify(result), 'EX', 86_400).catch(() => {});
          return result;
        }
      } catch (error) {
        if (!isUniqueConstraint(error) || attempt === 2) throw error;
        continue;
      }
      const concurrent = await db.party.findFirst({ where: { id: party.id, hostUserId: ctx.user.userId } });
      if (concurrent?.status === 'published' && concurrent.passCode) {
        return { id: concurrent.id, shareUrl: partyShareUrl(concurrent.id), passCode: concurrent.passCode };
      }
      throw new TRPCError({ code: 'CONFLICT', message: 'Party could not be published. Please retry.' });
    }
    throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Party pass generation failed.' });
  });

function parsedTicketTiers(value: Prisma.JsonValue): z.infer<typeof ticketTierInput>[] {
  const parsed = z.array(ticketTierInput).safeParse(value);
  return parsed.success ? parsed.data : [];
}

function activityHighlights(value: Prisma.JsonValue): string[] {
  const parsed = z.array(z.object({ title: z.string() })).safeParse(value);
  return parsed.success ? parsed.data.map((item) => item.title) : [];
}

function safeDestinations(value: Prisma.JsonValue | null): z.infer<typeof hostDestinationsInput> | null {
  const parsed = hostDestinationsInput.safeParse(value ?? {});
  return parsed.success ? parsed.data : null;
}

async function publishedParty(partyId: string) {
  const party = await db.party.findFirst({
    where: { id: partyId, status: 'published' },
    include: {
      host: { select: { name: true } },
      media: { orderBy: { position: 'asc' } },
    },
  });
  if (!party) throw new TRPCError({ code: 'NOT_FOUND', message: 'Party Pass not found.' });
  return party;
}

function passAction(party: { accessMode: string }, guest: { status: string; accessGranted: boolean } | null, isAuthenticated: boolean) {
  if (!isAuthenticated) return { action: 'authenticate', status: 'anonymous', accessGranted: false } as const;
  if (guest?.accessGranted) return { action: 'view-pass', status: guest.status, accessGranted: true } as const;
  if (guest?.status === 'pending') return { action: 'unavailable', status: 'pending', accessGranted: false } as const;
  if (guest?.status === 'declined') return { action: 'unavailable', status: 'declined', accessGranted: false } as const;
  if (party.accessMode === 'paid-ticket') return { action: 'ticket', status: guest?.status ?? 'eligible', accessGranted: false } as const;
  if (party.accessMode === 'private-approval') return { action: 'request-approval', status: guest?.status ?? 'eligible', accessGranted: false } as const;
  return { action: 'rsvp', status: guest?.status ?? 'eligible', accessGranted: false } as const;
}

export const partyInvite = publicProcedure
  .input(z.object({ partyId: z.string().min(1).max(128) }))
  .query(async ({ input }) => {
    const party = await publishedParty(input.partyId);
    const destinations = safeDestinations(party.hostDestinations);
    const cover = party.media.find((media) => media.kind === 'cover');
    const album = party.media.filter((media) => media.kind === 'album');
    return {
      id: party.id,
      source: 'host-studio-party' as const,
      title: party.title,
      inviteNote: party.tagline,
      templateId: party.templateId,
      tier: party.requiredMembershipTier,
      hostName: party.host.name ?? 'Bytspot Host',
      host: { name: party.host.name ?? 'Bytspot Host', destinations: destinations ?? {} },
      scheduledDate: party.startsAt.toISOString(),
      locationLabel: party.locationDisclosure === 'public' ? party.venueName : null,
      locationDisclosure: party.locationDisclosure,
      accessMode: party.accessMode,
      capacity: party.capacity,
      participantCount: await db.partyGuest.count({ where: { partyId: party.id, accessGranted: true } }),
      ticketTiers: parsedTicketTiers(party.ticketTiers),
      activityHighlights: activityHighlights(party.itinerary),
      heroImageURL: cover ? partyMediaUrl(cover.id) : null,
      thumbnailURL: cover ? partyMediaUrl(cover.id) : null,
      photoURLs: album.map((media) => partyMediaUrl(media.id)),
    };
  });

export const partyPassRouter = router({
  resolve: publicProcedure
    .input(z.object({ partyId: z.string().min(1).max(128) }))
    .query(async ({ ctx, input }) => {
      const party = await publishedParty(input.partyId);
      const guest = ctx.user
        ? await db.partyGuest.findUnique({ where: { partyId_userId: { partyId: party.id, userId: ctx.user.userId } } })
        : null;
      const state = passAction(party, guest, Boolean(ctx.user));
      return { partyId: party.id, action: state.action, guest: { status: state.status, accessGranted: state.accessGranted } };
    }),
});

export const partyRsvpRouter = router({
  create: protectedProcedure
    .use(rateLimitMiddleware({ windowMs: 60_000, max: 10, label: 'party-rsvp-create' }))
    .input(z.object({ partyId: z.string().min(1).max(128), idempotencyKey: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const party = await publishedParty(input.partyId);
      if (party.accessMode === 'paid-ticket') throw new TRPCError({ code: 'BAD_REQUEST', message: 'Paid Parties require ticket checkout.' });
      const existing = await db.partyGuest.findUnique({ where: { partyId_userId: { partyId: party.id, userId: ctx.user.userId } } });
      if (existing?.status === 'declined') throw new TRPCError({ code: 'FORBIDDEN', message: 'The host has declined this Party request.' });
      if (existing?.accessGranted) return { status: existing.status, accessGranted: true };
      const approvalRequired = party.accessMode === 'private-approval';
      const status = approvalRequired ? 'pending' : 'rsvp';
      const accessGranted = !approvalRequired;
      if (accessGranted && !existing) {
        const grantedCount = await db.partyGuest.count({ where: { partyId: party.id, accessGranted: true } });
        if (grantedCount >= party.capacity) throw new TRPCError({ code: 'CONFLICT', message: 'This Party is at capacity.' });
      }
      const guest = await db.partyGuest.upsert({
        where: { partyId_userId: { partyId: party.id, userId: ctx.user.userId } },
        create: { partyId: party.id, userId: ctx.user.userId, status, accessGranted },
        update: { status, accessGranted },
      });
      return { status: guest.status, accessGranted: guest.accessGranted };
    }),
});

export const partyTicketsRouter = router({
  createCheckout: protectedProcedure
    .use(rateLimitMiddleware({ windowMs: 60_000, max: 5, label: 'party-ticket-checkout' }))
    .input(z.object({ partyId: z.string().min(1).max(128), ticketTierName: z.string().trim().min(1).max(100), idempotencyKey: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const party = await publishedParty(input.partyId);
      if (party.accessMode !== 'paid-ticket') throw new TRPCError({ code: 'BAD_REQUEST', message: 'This Party does not use paid tickets.' });
      const ticketTier = parsedTicketTiers(party.ticketTiers).find((tier) => tier.name === input.ticketTierName && tier.priceCents > 0);
      if (!ticketTier) throw new TRPCError({ code: 'NOT_FOUND', message: 'That ticket tier is no longer available.' });
      const knownGuest = await db.partyGuest.findUnique({ where: { partyId_userId: { partyId: party.id, userId: ctx.user.userId } } });
      if (knownGuest?.status === 'declined') throw new TRPCError({ code: 'FORBIDDEN', message: 'The host has declined this Party request.' });
      if (knownGuest?.accessGranted) throw new TRPCError({ code: 'CONFLICT', message: 'This Party Pass is already confirmed.' });
      if (!config.stripeSecretKey) throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'Party Checkout is not configured.' });

      const now = new Date();
      const reservation = await db.$transaction(async (tx) => {
        const existing = await tx.partyCheckout.findUnique({ where: { partyId_userId_idempotencyKey: { partyId: party.id, userId: ctx.user.userId, idempotencyKey: input.idempotencyKey } } });
        if (existing) {
          if (existing.status === 'completed') throw new TRPCError({ code: 'CONFLICT', message: 'This ticket is already confirmed.' });
          if (existing.status === 'expired') throw new TRPCError({ code: 'CONFLICT', message: 'This Checkout expired. Start a new checkout.' });
          return existing;
        }

        const guest = await tx.partyGuest.findUnique({ where: { partyId_userId: { partyId: party.id, userId: ctx.user.userId } } });
        if (guest?.status === 'declined') throw new TRPCError({ code: 'FORBIDDEN', message: 'The host has declined this Party request.' });
        if (guest?.accessGranted) throw new TRPCError({ code: 'CONFLICT', message: 'This Party Pass is already confirmed.' });

        const activeReservationWhere = {
          partyId: party.id,
          OR: [
            { status: 'completed' },
            { status: { in: ['creating', 'pending'] }, reservationExpiresAt: { gt: now } },
          ],
        };
        const [activePartyReservations, activeTierReservations] = await Promise.all([
          tx.partyCheckout.count({ where: activeReservationWhere }),
          tx.partyCheckout.count({ where: { ...activeReservationWhere, ticketTierName: ticketTier.name } }),
        ]);
        if (activePartyReservations >= party.capacity) throw new TRPCError({ code: 'CONFLICT', message: 'This Party is at capacity.' });
        if (activeTierReservations >= ticketTier.quantity) throw new TRPCError({ code: 'CONFLICT', message: 'That ticket tier is sold out.' });

        const partyGuest = guest
          ? await tx.partyGuest.update({ where: { id: guest.id }, data: { status: 'checkout-pending', accessGranted: false, ticketTierName: ticketTier.name } })
          : await tx.partyGuest.create({ data: { partyId: party.id, userId: ctx.user.userId, status: 'checkout-pending', accessGranted: false, ticketTierName: ticketTier.name } });
        return tx.partyCheckout.create({
          data: {
            partyId: party.id, partyGuestId: partyGuest.id, userId: ctx.user.userId, idempotencyKey: input.idempotencyKey,
            ticketTierName: ticketTier.name, amountCents: ticketTier.priceCents, currency: 'usd', status: 'creating',
            reservationExpiresAt: new Date(now.getTime() + 10 * 60 * 1000),
          },
        });
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });

      if (reservation.checkoutUrl && reservation.status === 'pending') return { url: reservation.checkoutUrl };
      const stripe = new Stripe(config.stripeSecretKey);
      const session = await stripe.checkout.sessions.create({
        mode: 'payment',
        payment_method_types: ['card'],
        line_items: [{
          price_data: {
            currency: 'usd',
            unit_amount: ticketTier.priceCents,
            product_data: { name: `${party.title} · ${ticketTier.name}`, description: party.tagline },
          },
          quantity: 1,
        }],
        metadata: { kind: 'party-ticket', checkoutId: reservation.id, partyId: party.id, userId: ctx.user.userId, ticketTierName: ticketTier.name, idempotencyKey: input.idempotencyKey },
        success_url: `${partyShareUrl(party.id)}?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${partyShareUrl(party.id)}?checkout=cancelled`,
      }, { idempotencyKey: input.idempotencyKey });
      if (!session.url) throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Stripe Checkout did not return a hosted URL.' });
      await db.partyCheckout.update({
        where: { id: reservation.id },
        data: {
          stripeSessionId: session.id, checkoutUrl: session.url, status: 'pending',
          reservationExpiresAt: session.expires_at ? new Date(session.expires_at * 1000) : reservation.reservationExpiresAt,
        },
      });
      return { url: session.url };
    }),
});