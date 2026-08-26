import { randomBytes } from 'crypto';
import { TRPCError } from '@trpc/server';
import { Prisma } from '@prisma/client';
import Stripe from 'stripe';
import { z } from 'zod';
import { config } from '../config';
import { alertGuestOfDecision, alertHostOfDoorArrival, alertHostOfGuestResponse, dispatchPartyAlert } from '../services/partyAlerts';
import { db } from '../lib/db';
import { serializableTransaction } from '../lib/transactions';
import { isMembershipTier, meetsRequiredMembershipTier, type MembershipTier } from '../lib/membershipTier';
import { getRedis } from '../lib/redis';
import { handoffUrl } from './mobilityRouter';
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

/**
 * Official Host identity. Socials store handles — Bytspot owns the routing —
 * while music/merch/website store HTTPS URLs that are never shown publicly.
 * The list is ordered (host reorders pills) with at most one primary ⭐.
 */
const socialDestinationKinds = ['instagram', 'tiktok', 'youtube', 'x', 'facebook', 'linkedin'] as const;
const linkDestinationKinds = ['music', 'merch', 'website'] as const;
const destinationKinds = [...socialDestinationKinds, ...linkDestinationKinds] as const;
type DestinationKind = (typeof destinationKinds)[number];

const hostHandle = z.string().trim().regex(/^@?(?=.*[a-z0-9])[a-z0-9._]{2,30}$/i, 'Handles are 2–30 letters, numbers, dots, or underscores.').transform((value) => value.replace(/^@/, '').toLowerCase());

const destinationEntry = z.object({
  kind: z.enum(destinationKinds),
  value: z.string().trim().min(1).max(2048),
  primary: z.boolean().optional(),
}).superRefine((entry, ctx) => {
  if ((socialDestinationKinds as readonly string[]).includes(entry.kind)) {
    // At least one alphanumeric: all-dot handles would route to a social root.
    if (!/^@?(?=.*[a-z0-9])[a-z0-9._\-]{1,80}$/i.test(entry.value)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['value'], message: 'Social destinations take a handle, not a link.' });
    }
  } else if (!httpsUrl.safeParse(entry.value).success) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['value'], message: 'Official destinations must use HTTPS.' });
  }
});

const destinationList = z.array(destinationEntry).max(destinationKinds.length).superRefine((list, ctx) => {
  if (new Set(list.map((entry) => entry.kind)).size !== list.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Each destination can only appear once.' });
  }
  if (list.filter((entry) => entry.primary).length > 1) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Only one destination can be primary.' });
  }
});

const profileIdentityInput = z.object({ handle: hostHandle.nullish(), destinations: destinationList });

/** Bytspot owns social routing: handles resolve to canonical profile URLs. */
function socialProfileUrl(kind: DestinationKind, handle: string): string {
  const clean = handle.replace(/^@/, '');
  switch (kind) {
    case 'instagram': return `https://instagram.com/${clean}`;
    case 'tiktok': return `https://tiktok.com/@${clean}`;
    case 'youtube': return `https://youtube.com/@${clean}`;
    case 'x': return `https://x.com/${clean}`;
    case 'facebook': return `https://facebook.com/${clean}`;
    case 'linkedin': return `https://linkedin.com/in/${clean}`;
    default: return clean;
  }
}

const destinationDisplayNames: Record<DestinationKind, string> = {
  instagram: 'Instagram', tiktok: 'TikTok', youtube: 'YouTube', x: 'X', facebook: 'Facebook', linkedin: 'LinkedIn',
  music: 'Music', merch: 'Merch', website: 'Website',
};

/**
 * Public projection: label is the @handle for socials or the display name for
 * links — raw URLs never appear as text, they only power the tap-through.
 */
function projectDestinationList(value: Prisma.JsonValue | null | undefined): Array<{ kind: DestinationKind; label: string; url: string; primary: boolean }> {
  const parsed = destinationList.safeParse(value ?? []);
  if (!parsed.success) return [];
  return parsed.data.map((entry) => {
    const isSocial = (socialDestinationKinds as readonly string[]).includes(entry.kind);
    return {
      kind: entry.kind,
      label: isSocial ? `@${entry.value.replace(/^@/, '')}` : destinationDisplayNames[entry.kind],
      url: isSocial ? socialProfileUrl(entry.kind, entry.value) : entry.value,
      primary: entry.primary === true,
    };
  });
}

const draftInput = z.object({
  idempotencyKey: z.string().uuid(),
  templateId: z.enum(partyKinds),
  title: z.string().trim().min(3).max(140),
  tagline: z.string().trim().max(280),
  startsAt: z.string().datetime({ offset: true }),
  endsAt: z.string().datetime({ offset: true }).nullish(),
  venueName: z.string().trim().min(1).max(200),
  locationDisclosure: z.enum(locationDisclosures).default('public'),
  capacity: z.number().int().min(2).max(10_000),
  accessMode: z.enum(accessModes),
  requiredMembershipTier: z.enum(tiers),
  hostDestinations: hostDestinationsInput.optional(),
  audienceCircleIds: z.array(z.string().min(1).max(128)).max(100),
  itinerary: z.array(z.object({ title: z.string().trim().min(1).max(160), offsetMinutes: z.number().int().min(0).max(10_080) })).max(30),
  ticketTiers: z.array(ticketTierInput).max(10),
  cohosts: z.array(z.object({ email: z.string().email().max(255), role: z.enum(hostRoles) })).max(20),
  templateConfig: z.object({ kind: z.enum(templateConfigKinds) }).passthrough(),
  source: z.literal('host-studio'),
}).superRefine((input, ctx) => {
  if (input.endsAt) {
    const startsAt = Date.parse(input.startsAt);
    const endsAt = Date.parse(input.endsAt);
    if (endsAt <= startsAt) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['endsAt'], message: 'Party end must be after the start.' });
    } else if (endsAt - startsAt > 7 * 24 * 60 * 60 * 1000) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['endsAt'], message: 'Party cannot run longer than 7 days.' });
    }
  }
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
  'templateId' | 'title' | 'tagline' | 'startsAt' | 'endsAt' | 'venueName' | 'locationDisclosure' | 'capacity' | 'accessMode' |
  'requiredMembershipTier' | 'hostDestinations' | 'audienceCircleIds' | 'itinerary' | 'ticketTiers' | 'cohosts' | 'templateConfig'>;

/**
 * Run of Show slice 1: hosts may set an explicit end; otherwise the last
 * itinerary beat + 60 minutes closes the party. No end and no beats leaves
 * endsAt null (share-link fallback of startsAt + 6h still applies).
 */
function derivedEndsAt(input: z.infer<typeof draftInput>): Date | null {
  if (input.endsAt) return new Date(input.endsAt);
  if (input.itinerary.length === 0) return null;
  const lastOffset = Math.max(...input.itinerary.map((item) => item.offsetMinutes));
  return new Date(Date.parse(input.startsAt) + (lastOffset + 60) * 60 * 1000);
}

function partyContent(input: z.infer<typeof draftInput>): PartyContent {
  return {
    templateId: input.templateId, title: input.title, tagline: input.tagline, startsAt: new Date(input.startsAt), endsAt: derivedEndsAt(input), venueName: input.venueName, locationDisclosure: input.locationDisclosure,
    capacity: input.capacity, accessMode: input.accessMode, requiredMembershipTier: input.requiredMembershipTier,
    hostDestinations: (input.hostDestinations ?? null) as Prisma.InputJsonValue, audienceCircleIds: input.audienceCircleIds, itinerary: input.itinerary, ticketTiers: input.ticketTiers,
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

  /**
   * Delete a party the caller hosts. Drafts always delete. Published
   * parties delete only while money is not in motion: deletion is refused
   * once any guest is ticketed or checked in, or any Stripe checkout is
   * completed or still inside its reservation window — deleting mid-payment
   * would strip the webhook of the rows it needs to reconcile or refund.
   * Guests, media, checkouts, and encounter opt-ins cascade at the DB level.
   */
  delete: protectedProcedure
    .use(rateLimitMiddleware({ windowMs: 60_000, max: 10, label: 'party-draft-delete' }))
    .input(z.object({ partyId: z.string().min(1).max(128) }))
    .mutation(async ({ ctx, input }) => {
      const party = await db.party.findFirst({
        where: { id: input.partyId, hostUserId: ctx.user.userId },
        select: { id: true, status: true },
      });
      if (!party) throw new TRPCError({ code: 'NOT_FOUND', message: 'Party not found.' });
      const committedGuests = { OR: [{ status: 'ticketed' }, { checkedInAt: { not: null } }] };
      const activeCheckouts = {
        OR: [
          { status: 'completed' },
          { status: { in: ['creating', 'pending'] }, reservationExpiresAt: { gt: new Date() } },
        ],
      };
      if (party.status === 'published') {
        const [committedGuest, activeCheckout] = await Promise.all([
          db.partyGuest.findFirst({ where: { partyId: party.id, ...committedGuests }, select: { id: true } }),
          db.partyCheckout.findFirst({ where: { partyId: party.id, ...activeCheckouts }, select: { id: true } }),
        ]);
        if (committedGuest || activeCheckout) {
          throw new TRPCError({ code: 'CONFLICT', message: 'This Party has ticketed, checked-in, or mid-checkout guests and can no longer be deleted.' });
        }
      }
      // Guard against a guest paying between the check and the delete: the
      // conditional deleteMany re-verifies host + deletable state atomically,
      // including in-flight checkouts the webhook may still reconcile.
      const deleted = await db.party.deleteMany({
        where: {
          id: party.id,
          hostUserId: ctx.user.userId,
          guests: { none: committedGuests },
          checkouts: { none: activeCheckouts },
        },
      });
      if (deleted.count === 0) {
        throw new TRPCError({ code: 'CONFLICT', message: 'This Party has ticketed, checked-in, or mid-checkout guests and can no longer be deleted.' });
      }
      return { success: true };
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
    // Snapshot the Official Host identity so later profile edits never
    // rewrite an already-shared pass. The profile remains the source of truth
    // for the next party.
    const profile = await db.hostProfile.findUnique({ where: { userId: ctx.user.userId }, select: { handle: true, hostDestinations: true } });
    const profileList = destinationList.safeParse(profile?.hostDestinations ?? []);
    // A handle-only identity is still an identity: snapshot whenever the
    // profile carries a handle or at least one valid destination.
    if (profile && profileList.success && (profile.handle || profileList.data.length > 0)) {
      await db.party.updateMany({
        where: { id: party.id, hostUserId: ctx.user.userId, status: 'draft' },
        data: { hostDestinations: { identity: true, handle: profile.handle, destinations: profileList.data } as Prisma.InputJsonValue },
      });
    }
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

/**
 * Absolute schedule for the Party Pass: each beat's time derives from the
 * party clock (startsAt + offset). The client decides "Now" locally; no cron.
 */
function runOfShow(startsAt: Date, value: Prisma.JsonValue): Array<{ title: string; scheduledAt: string }> {
  const parsed = z.array(z.object({ title: z.string(), offsetMinutes: z.number().int().min(0) })).safeParse(value);
  if (!parsed.success) return [];
  return parsed.data.map((item) => ({ title: item.title, scheduledAt: new Date(startsAt.getTime() + item.offsetMinutes * 60 * 1000).toISOString() }));
}

function safeDestinations(value: Prisma.JsonValue | null): z.infer<typeof hostDestinationsInput> | null {
  const parsed = hostDestinationsInput.safeParse(value ?? {});
  if (!parsed.success) return null;
  // Legacy `primarySocial.platform` is arbitrary stored text that shipped
  // clients render as the public label. Anything URL-like or unrecognized
  // collapses to a known display name so a raw URL can never render as text.
  if (parsed.data.primarySocial) {
    const known = socialDestinationKinds.map((kind) => destinationDisplayNames[kind]).find((name) => name.toLowerCase() === parsed.data.primarySocial.platform.toLowerCase());
    parsed.data.primarySocial.platform = known ?? 'Social';
  }
  return parsed.data;
}

/**
 * Publish-time snapshot of the Official Host identity. Distinguishable from
 * the legacy per-party destinations object by its `identity` marker.
 */
const identitySnapshot = z.object({
  identity: z.literal(true),
  handle: z.string().nullable(),
  destinations: destinationList,
});

function safeIdentitySnapshot(value: Prisma.JsonValue | null): z.infer<typeof identitySnapshot> | null {
  const parsed = identitySnapshot.safeParse(value ?? {});
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

/**
 * When the share link stops resolving for members without access. The host
 * override wins; otherwise the link dies when the party ends (endsAt, with a
 * 6-hour grace window after startsAt when no end time was set — the same
 * fallback People You Met uses).
 */
function shareLinkExpiry(party: { shareLinkExpiresAt: Date | null; endsAt: Date | null; startsAt: Date }): Date {
  if (party.shareLinkExpiresAt) return party.shareLinkExpiresAt;
  return party.endsAt ?? new Date(party.startsAt.getTime() + 6 * 60 * 60 * 1000);
}

export function shareLinkExpired(party: { shareLinkExpiresAt: Date | null; endsAt: Date | null; startsAt: Date }): boolean {
  return shareLinkExpiry(party).getTime() <= Date.now();
}

/**
 * An expired share link must be indistinguishable from a deleted party for
 * anyone who does not already hold access — confirmed guests keep their pass
 * and the host keeps Party Control (both use host/guest-scoped procedures).
 */
function assertShareLinkUsable(
  party: { shareLinkExpiresAt: Date | null; endsAt: Date | null; startsAt: Date; hostUserId?: string },
  guest: { accessGranted: boolean } | null,
  viewerUserId?: string | null,
): void {
  if (guest?.accessGranted) return;
  // A host must always be able to open their own party, including after the
  // share link has stopped admitting new arrivals.
  if (viewerUserId && party.hostUserId && viewerUserId === party.hostUserId) return;
  if (shareLinkExpired(party)) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Party Pass not found.' });
  }
}

async function membershipTierFor(userId: string): Promise<MembershipTier | null> {
  const user = await db.user.findUnique({ where: { id: userId }, select: { membershipTier: true } });
  return isMembershipTier(user?.membershipTier) ? user.membershipTier : null;
}

function passAction(party: { accessMode: string; requiredMembershipTier: string; hostUserId: string }, guest: { status: string; accessGranted: boolean } | null, isAuthenticated: boolean, membershipEligible: boolean, viewerUserId?: string | null) {
  if (!isAuthenticated) return { action: 'authenticate', status: 'anonymous', accessGranted: false } as const;
  // The host holds their own door. Membership tier and access mode gate the
  // guests a host admits, never the host: a host is not a guest of their own
  // party, so without this they fall through to "membership-required" or are
  // asked to buy a ticket to their own room.
  if (viewerUserId && viewerUserId === party.hostUserId) {
    return { action: 'view-pass', status: 'host', accessGranted: true } as const;
  }
  if (!membershipEligible) return { action: 'unavailable', status: 'membership-required', accessGranted: false } as const;
  if (guest?.accessGranted) return { action: 'view-pass', status: guest.status, accessGranted: true } as const;
  if (guest?.status === 'pending') return { action: 'unavailable', status: 'pending', accessGranted: false } as const;
  if (guest?.status === 'declined') return { action: 'unavailable', status: 'declined', accessGranted: false } as const;
  if (guest?.status === 'refund-required') return { action: 'unavailable', status: 'refund-required', accessGranted: false } as const;
  if (party.accessMode === 'paid-ticket') return { action: 'ticket', status: guest?.status ?? 'eligible', accessGranted: false } as const;
  if (party.accessMode === 'private-approval') return { action: 'request-approval', status: guest?.status ?? 'eligible', accessGranted: false } as const;
  return { action: 'rsvp', status: guest?.status ?? 'eligible', accessGranted: false } as const;
}

function normalizedVenueName(value: string): string {
  return value.trim().toLocaleLowerCase().split(/\s+/).join(' ');
}

async function authorizedPartyArrival(partyId: string, userId: string) {
  const party = await db.party.findFirst({
    where: { id: partyId, status: 'published' },
    include: { arrivalVenue: { select: { id: true, name: true, address: true, lat: true, lng: true } } },
  });
  if (!party) throw new TRPCError({ code: 'NOT_FOUND', message: 'Party Pass not found.' });
  const isHost = party.hostUserId === userId;
  if (!isHost && !meetsRequiredMembershipTier(await membershipTierFor(userId), party.requiredMembershipTier)) {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'Your membership tier does not meet this Party requirement.' });
  }
  if (!isHost) {
    const guest = await db.partyGuest.findUnique({ where: { partyId_userId: { partyId: party.id, userId } } });
    if (!guest?.accessGranted) throw new TRPCError({ code: 'FORBIDDEN', message: 'Party access is required before arrival guidance is available.' });
  }
  if (!party.arrivalVenue) throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'Arrival guidance is not enabled for this Party.' });
  return party;
}

async function hasPremiumMobilityEntitlement(userId: string): Promise<boolean> {
  return meetsRequiredMembershipTier(await membershipTierFor(userId), 'platinum');
}

export const partyInvite = publicProcedure
  .input(z.object({ partyId: z.string().min(1).max(128) }))
  .query(async ({ ctx, input }) => {
    const party = await publishedParty(input.partyId);
    const guest = ctx.user
      ? await db.partyGuest.findUnique({ where: { partyId_userId: { partyId: party.id, userId: ctx.user.userId } } })
      : null;
    assertShareLinkUsable(party, guest, ctx.user?.userId);
    const identity = safeIdentitySnapshot(party.hostDestinations);
    const destinations = identity ? null : safeDestinations(party.hostDestinations);
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
      host: {
        name: party.host.name ?? 'Bytspot Host',
        // Legacy per-party object (shipped clients) — empty when the party
        // carries the new identity snapshot.
        destinations: destinations ?? {},
        handle: identity?.handle ?? null,
        // Ordered public list: label only (never a raw URL); url powers tap-through.
        destinationList: projectDestinationList(identity?.destinations ?? null),
      },
      scheduledDate: party.startsAt.toISOString(),
      endsAt: party.endsAt?.toISOString() ?? null,
      runOfShow: runOfShow(party.startsAt, party.itinerary),
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

export const hostDestinationsRouter = router({
  get: protectedProcedure.query(async ({ ctx }) => {
    const profile = await db.hostProfile.findUnique({ where: { userId: ctx.user.userId }, select: { handle: true, hostDestinations: true } });
    const parsed = destinationList.safeParse(profile?.hostDestinations ?? []);
    return { handle: profile?.handle ?? null, destinations: parsed.success ? parsed.data : [] };
  }),
  save: protectedProcedure
    .input(profileIdentityInput)
    .mutation(async ({ ctx, input }) => {
      // Host Studio no longer collects a handle — the verified host name is
      // the sign-in identity. Only overwrite handle when the client sent one.
      const handle = input.handle === undefined ? undefined : input.handle ?? null;
      try {
        await db.hostProfile.upsert({
          where: { userId: ctx.user.userId },
          update: {
            ...(handle !== undefined ? { handle } : {}),
            hostDestinations: input.destinations as Prisma.InputJsonValue,
          },
          create: { userId: ctx.user.userId, handle: handle ?? null, hostDestinations: input.destinations as Prisma.InputJsonValue },
        });
      } catch (error) {
        if (isUniqueConstraint(error)) throw new TRPCError({ code: 'CONFLICT', message: 'That handle is already taken.' });
        throw error;
      }
      return { handle, destinations: input.destinations };
    }),
});

export const partyPassRouter = router({
  resolve: publicProcedure
    .input(z.object({ partyId: z.string().min(1).max(128) }))
    .query(async ({ ctx, input }) => {
      const party = await publishedParty(input.partyId);
      const guest = ctx.user
        ? await db.partyGuest.findUnique({ where: { partyId_userId: { partyId: party.id, userId: ctx.user.userId } } })
        : null;
      assertShareLinkUsable(party, guest, ctx.user?.userId);
      const membershipTier = ctx.user ? await membershipTierFor(ctx.user.userId) : null;
      const state = passAction(party, guest, Boolean(ctx.user), meetsRequiredMembershipTier(membershipTier, party.requiredMembershipTier), ctx.user?.userId);
      const premiumMobilityEligible = Boolean(ctx.user && state.accessGranted && party.arrivalVenueId && meetsRequiredMembershipTier(membershipTier, 'platinum'));
      return { partyId: party.id, action: state.action, guest: { status: state.status, accessGranted: state.accessGranted }, premiumMobilityEligible };
    }),

  /**
   * Issues the guest's opaque bearer credential (32 random bytes, base64url —
   * exactly 43 characters). Only the authorized guest may fetch it; only the
   * host consumes it at the door through events.control.checkIn.
   */
  attendeeCredential: protectedProcedure
    .use(rateLimitMiddleware({ windowMs: 60_000, max: 10, label: 'party-attendee-credential' }))
    .input(z.object({ partyId: z.string().min(1).max(128) }))
    .mutation(async ({ ctx, input }) => {
      const party = await db.party.findFirst({ where: { id: input.partyId, status: 'published' }, select: { id: true } });
      if (!party) throw new TRPCError({ code: 'NOT_FOUND', message: 'Party Pass not found.' });
      const guest = await db.partyGuest.findUnique({ where: { partyId_userId: { partyId: party.id, userId: ctx.user.userId } } });
      if (!guest?.accessGranted) throw new TRPCError({ code: 'FORBIDDEN', message: 'Party access is required before an attendee credential is issued.' });
      if (guest.credential) return { partyId: party.id, attendeeCredential: guest.credential };
      for (let attempt = 0; attempt < 3; attempt++) {
        const credential = randomBytes(32).toString('base64url');
        try {
          const updated = await db.partyGuest.updateMany({ where: { id: guest.id, credential: null }, data: { credential } });
          if (updated.count === 1) return { partyId: party.id, attendeeCredential: credential };
          break;
        } catch (error) {
          if (!isUniqueConstraint(error) || attempt === 2) throw error;
        }
      }
      const issued = await db.partyGuest.findUnique({ where: { id: guest.id } });
      if (issued?.credential) return { partyId: party.id, attendeeCredential: issued.credential };
      throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Attendee credential issuance failed.' });
    }),
});

/**
 * ── Party Control (host console) ────────────────────────
 * Every procedure is host-only: the authenticated user must own the
 * published Party or the request fails closed with NOT_FOUND.
 */
async function hostControlledParty(partyId: string, userId: string) {
  const party = await db.party.findFirst({ where: { id: partyId, hostUserId: userId, status: 'published' } });
  if (!party) throw new TRPCError({ code: 'NOT_FOUND', message: 'Published Party not found for this host.' });
  return party;
}

const attendeeCredentialInput = z.string().regex(/^[A-Za-z0-9_-]{43}$/, 'Attendee credentials are 43 base64url characters.');

export const partyControlRouter = router({
  /**
   * Rooms this host can reopen in Party Control. Drafts are omitted —
   * Control is a published-party console. Newest first so the room they
   * just left is on top.
   */
  hosted: protectedProcedure.query(async ({ ctx }) => {
    const parties = await db.party.findMany({
      where: { hostUserId: ctx.user.userId, status: 'published' },
      orderBy: [{ startsAt: 'desc' }],
      take: 50,
      select: {
        id: true,
        title: true,
        venueName: true,
        startsAt: true,
        endsAt: true,
        admissionPaused: true,
        shareLinkExpiresAt: true,
        passCode: true,
        capacity: true,
      },
    });
    return {
      parties: parties.map((party) => ({
        id: party.id,
        title: party.title,
        venueName: party.venueName,
        startsAt: party.startsAt.toISOString(),
        endsAt: party.endsAt?.toISOString() ?? null,
        admissionPaused: party.admissionPaused,
        shareUrl: partyShareUrl(party.id),
        passCode: party.passCode ?? null,
        shareLinkExpiresAt: shareLinkExpiry(party).toISOString(),
        shareLinkExpired: shareLinkExpired(party),
        capacity: party.capacity,
      })),
    };
  }),

  summary: protectedProcedure
    .input(z.object({ partyId: z.string().min(1).max(128) }))
    .query(async ({ ctx, input }) => {
      const party = await hostControlledParty(input.partyId, ctx.user.userId);
      const [confirmed, pending, checkedIn] = await Promise.all([
        db.partyGuest.count({ where: { partyId: party.id, accessGranted: true } }),
        db.partyGuest.count({ where: { partyId: party.id, status: 'pending' } }),
        db.partyGuest.count({ where: { partyId: party.id, status: 'checked-in' } }),
      ]);
      return {
        partyId: party.id,
        title: party.title,
        admissionPaused: party.admissionPaused,
        capacity: party.capacity,
        confirmed,
        spacesRemaining: Math.max(party.capacity - confirmed, 0),
        pending,
        checkedIn,
        shareUrl: partyShareUrl(party.id),
        passCode: party.passCode ?? null,
        shareLinkExpiresAt: shareLinkExpiry(party).toISOString(),
        shareLinkExpired: shareLinkExpired(party),
        shareLinkExpiryIsDefault: party.shareLinkExpiresAt === null,
      };
    }),

  /**
   * Host override for when the share link stops resolving. Null restores the
   * default: the link dies when the party ends. Confirmed guests and the
   * host are never affected — expiry only gates new arrivals via the link.
   */
  setShareLinkExpiry: protectedProcedure
    .use(rateLimitMiddleware({ windowMs: 60_000, max: 20, label: 'party-control-share-expiry' }))
    .input(z.object({ partyId: z.string().min(1).max(128), expiresAt: z.string().datetime().nullable() }))
    .mutation(async ({ ctx, input }) => {
      const party = await hostControlledParty(input.partyId, ctx.user.userId);
      const expiresAt = input.expiresAt === null ? null : new Date(input.expiresAt);
      if (expiresAt && expiresAt.getTime() <= Date.now()) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'The share link expiry must be in the future. To stop new arrivals now, pause admissions instead.' });
      }
      const updated = await db.party.updateMany({
        where: { id: party.id, hostUserId: ctx.user.userId, status: 'published' },
        data: { shareLinkExpiresAt: expiresAt },
      });
      if (updated.count !== 1) throw new TRPCError({ code: 'NOT_FOUND', message: 'Published Party not found for this host.' });
      const effective = shareLinkExpiry({ shareLinkExpiresAt: expiresAt, endsAt: party.endsAt, startsAt: party.startsAt });
      return { partyId: party.id, shareLinkExpiresAt: effective.toISOString(), shareLinkExpiryIsDefault: expiresAt === null };
    }),

  guests: protectedProcedure
    .input(z.object({
      partyId: z.string().min(1).max(128),
      status: z.enum(['all', 'pending', 'rsvp', 'ticketed', 'approved', 'declined', 'checked-in', 'refund-required', 'checkout-pending']).default('all'),
    }))
    .query(async ({ ctx, input }) => {
      const party = await hostControlledParty(input.partyId, ctx.user.userId);
      const guests = await db.partyGuest.findMany({
        where: { partyId: party.id, ...(input.status === 'all' ? {} : { status: input.status }) },
        include: { user: { select: { id: true, name: true, profileImage: true } } },
        orderBy: { createdAt: 'asc' },
      });
      return {
        guests: guests.map((guest) => ({
          id: guest.id,
          status: guest.status,
          source: guest.ticketTierName ? 'ticket' : 'rsvp',
          ticketTierName: guest.ticketTierName,
          checkedInAt: guest.checkedInAt?.toISOString() ?? null,
          person: { userId: guest.user.id, name: guest.user.name ?? 'Bytspot member', profileImage: guest.user.profileImage },
        })),
      };
    }),

  setAdmissionPaused: protectedProcedure
    .use(rateLimitMiddleware({ windowMs: 60_000, max: 20, label: 'party-control-pause' }))
    .input(z.object({ partyId: z.string().min(1).max(128), paused: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      const updated = await db.party.updateMany({
        where: { id: input.partyId, hostUserId: ctx.user.userId, status: 'published' },
        data: { admissionPaused: input.paused },
      });
      if (updated.count !== 1) throw new TRPCError({ code: 'NOT_FOUND', message: 'Published Party not found for this host.' });
      return { partyId: input.partyId, admissionPaused: input.paused };
    }),

  decide: protectedProcedure
    .use(rateLimitMiddleware({ windowMs: 60_000, max: 30, label: 'party-control-decide' }))
    .input(z.object({
      partyId: z.string().min(1).max(128),
      guestId: z.string().min(1).max(128),
      decision: z.enum(['approved', 'declined']),
    }))
    .mutation(async ({ ctx, input }) => {
      const party = await hostControlledParty(input.partyId, ctx.user.userId);
      return serializableTransaction(async (tx) => {
        const guest = await tx.partyGuest.findFirst({ where: { id: input.guestId, partyId: party.id } });
        if (!guest) throw new TRPCError({ code: 'NOT_FOUND', message: 'Party guest not found.' });
        if (guest.status !== 'pending') throw new TRPCError({ code: 'CONFLICT', message: 'Only pending guests can be decided.' });
        if (input.decision === 'approved') {
          const grantedCount = await tx.partyGuest.count({ where: { partyId: party.id, accessGranted: true } });
          if (grantedCount >= party.capacity) throw new TRPCError({ code: 'CONFLICT', message: 'This Party is at capacity.' });
        }
        const updated = await tx.partyGuest.update({
          where: { id: guest.id },
          data: { status: input.decision, accessGranted: input.decision === 'approved' },
        });
        return { guestId: updated.id, status: updated.status, accessGranted: updated.accessGranted, guestUserId: updated.userId };
      }, 'Party capacity changed. Please retry.').then(({ guestUserId, ...result }) => {
        dispatchPartyAlert(alertGuestOfDecision({
          partyId: party.id, guestUserId, partyTitle: party.title ?? null, decision: input.decision,
        }));
        return result;
      });
    }),

  checkIn: protectedProcedure
    .use(rateLimitMiddleware({ windowMs: 60_000, max: 60, label: 'party-control-checkin' }))
    .input(z.object({ partyId: z.string().min(1).max(128), attendeeCredential: attendeeCredentialInput }))
    .mutation(async ({ ctx, input }) => {
      const party = await hostControlledParty(input.partyId, ctx.user.userId);
      return serializableTransaction(async (tx) => {
        const guest = await tx.partyGuest.findUnique({
          where: { credential: input.attendeeCredential },
          include: { user: { select: { name: true } } },
        });
        // A credential from another Party must be indistinguishable from an
        // unknown credential.
        if (!guest || guest.partyId !== party.id || !guest.accessGranted) {
          throw new TRPCError({ code: 'NOT_FOUND', message: 'That attendee credential is not recognized for this Party.' });
        }
        if (guest.status === 'checked-in') throw new TRPCError({ code: 'CONFLICT', message: 'This attendee has already been checked in.' });
        const updated = await tx.partyGuest.updateMany({
          where: { id: guest.id, status: { not: 'checked-in' }, accessGranted: true },
          data: { status: 'checked-in', checkedInAt: new Date() },
        });
        if (updated.count !== 1) throw new TRPCError({ code: 'CONFLICT', message: 'This attendee has already been checked in.' });
        return { status: 'checked-in' as const, guestName: guest.user.name ?? 'Bytspot member', arrivedName: guest.user.name ?? null };
      }, 'Door check-in conflicted. Please retry.').then(({ arrivedName, ...result }) => {
        dispatchPartyAlert(alertHostOfDoorArrival({ partyId: party.id, guestName: arrivedName }));
        return result;
      });
    }),
});

export const partyArrivalRouter = router({
  bindDestination: protectedProcedure
    .input(z.object({ partyId: z.string().min(1).max(128), venueId: z.string().min(1).max(128) }))
    .mutation(async ({ ctx, input }) => {
      const party = await db.party.findFirst({ where: { id: input.partyId, hostUserId: ctx.user.userId, status: 'published' }, select: { id: true, venueName: true } });
      if (!party) throw new TRPCError({ code: 'NOT_FOUND', message: 'Published Party not found for this host.' });
      const venue = await db.venue.findUnique({ where: { id: input.venueId }, select: { id: true, name: true, address: true } });
      if (!venue) throw new TRPCError({ code: 'NOT_FOUND', message: 'Registered arrival venue not found.' });
      if (normalizedVenueName(venue.name) !== normalizedVenueName(party.venueName)) {
        throw new TRPCError({ code: 'CONFLICT', message: 'The registered venue must match the Party venue name.' });
      }
      const updated = await db.party.updateMany({
        where: { id: party.id, hostUserId: ctx.user.userId, status: 'published' },
        data: { arrivalVenueId: venue.id },
      });
      if (updated.count !== 1) throw new TRPCError({ code: 'CONFLICT', message: 'The Party changed before its arrival destination could be saved.' });
      return { partyId: party.id, venue: { id: venue.id, name: venue.name, address: venue.address } };
    }),

  context: protectedProcedure
    .input(z.object({ partyId: z.string().min(1).max(128) }))
    .query(async ({ ctx, input }) => {
      const party = await authorizedPartyArrival(input.partyId, ctx.user.userId);
      const venue = party.arrivalVenue!;
      const directions = new URL('https://maps.apple.com/');
      directions.searchParams.set('daddr', `${venue.lat},${venue.lng}`);
      directions.searchParams.set('q', venue.name);
      directions.searchParams.set('dirflg', 'd');
      return {
        partyId: party.id,
        destination: { venueId: venue.id, name: venue.name, address: venue.address, latitude: venue.lat, longitude: venue.lng },
        map: { provider: 'apple-maps', directionsUrl: directions.toString() },
      };
    }),

  handoff: protectedProcedure
    .use(rateLimitMiddleware({ windowMs: 60_000, max: 6, label: 'party-arrival-handoff' }))
    .input(z.object({ partyId: z.string().min(1).max(128), provider: z.enum(['uber', 'lyft']) }))
    .mutation(async ({ ctx, input }) => {
      const party = await authorizedPartyArrival(input.partyId, ctx.user.userId);
      if (!await hasPremiumMobilityEntitlement(ctx.user.userId)) {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'Premium Party arrival handoff is available to Black and Platinum members only.' });
      }
      return { partyId: party.id, provider: input.provider, handoffUrl: handoffUrl(input.provider, party.arrivalVenue!), trackingMode: 'handoff-only' as const };
    }),
});

export const partyRsvpRouter = router({
  create: protectedProcedure
    .use(rateLimitMiddleware({ windowMs: 60_000, max: 10, label: 'party-rsvp-create' }))
    .input(z.object({ partyId: z.string().min(1).max(128), idempotencyKey: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const party = await publishedParty(input.partyId);
      const callerGuest = await db.partyGuest.findUnique({ where: { partyId_userId: { partyId: party.id, userId: ctx.user.userId } } });
      assertShareLinkUsable(party, callerGuest);
      if (party.accessMode === 'paid-ticket') throw new TRPCError({ code: 'BAD_REQUEST', message: 'Paid Parties require ticket checkout.' });
      if (!meetsRequiredMembershipTier(await membershipTierFor(ctx.user.userId), party.requiredMembershipTier)) {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'Your membership tier does not meet this Party requirement.' });
      }
      const approvalRequired = party.accessMode === 'private-approval';
      const status = approvalRequired ? 'pending' : 'rsvp';
      const accessGranted = !approvalRequired;
      return serializableTransaction(async (tx) => {
        const existing = await tx.partyGuest.findUnique({ where: { partyId_userId: { partyId: party.id, userId: ctx.user.userId } } });
        if (existing?.status === 'declined') throw new TRPCError({ code: 'FORBIDDEN', message: 'The host has declined this Party request.' });
        if (existing?.accessGranted) return { status: existing.status, accessGranted: true, joinedGuestList: false };
        if (party.admissionPaused) throw new TRPCError({ code: 'CONFLICT', message: 'The host has paused new admissions for this Party.' });
        if (accessGranted) {
          const grantedCount = await tx.partyGuest.count({ where: { partyId: party.id, accessGranted: true } });
          if (grantedCount >= party.capacity) throw new TRPCError({ code: 'CONFLICT', message: 'This Party is at capacity.' });
        }
        const guest = await tx.partyGuest.upsert({
          where: { partyId_userId: { partyId: party.id, userId: ctx.user.userId } },
          create: { partyId: party.id, userId: ctx.user.userId, status, accessGranted },
          update: { status, accessGranted },
        });
        return { status: guest.status, accessGranted: guest.accessGranted, joinedGuestList: !existing };
      }, 'Party capacity changed. Please retry.').then(({ joinedGuestList, ...result }) => {
        // Only joining the guest list is worth a push, and that decision is
        // read inside the transaction: a pre-read taken before it could let
        // two concurrent first RSVPs both look new and ring the host twice.
        if (joinedGuestList) {
          dispatchPartyAlert(alertHostOfGuestResponse({
            partyId: party.id, guestUserId: ctx.user.userId, approvalRequired,
          }));
        }
        return result;
      });
    }),
});

export const partyTicketsRouter = router({
  createCheckout: protectedProcedure
    .use(rateLimitMiddleware({ windowMs: 60_000, max: 5, label: 'party-ticket-checkout' }))
    .input(z.object({ partyId: z.string().min(1).max(128), ticketTierName: z.string().trim().min(1).max(100), idempotencyKey: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const party = await publishedParty(input.partyId);
      const knownGuest = await db.partyGuest.findUnique({ where: { partyId_userId: { partyId: party.id, userId: ctx.user.userId } } });
      assertShareLinkUsable(party, knownGuest);
      if (party.accessMode !== 'paid-ticket') throw new TRPCError({ code: 'BAD_REQUEST', message: 'This Party does not use paid tickets.' });
      const ticketTier = parsedTicketTiers(party.ticketTiers).find((tier) => tier.name === input.ticketTierName && tier.priceCents > 0);
      if (!ticketTier) throw new TRPCError({ code: 'NOT_FOUND', message: 'That ticket tier is no longer available.' });
      const membershipTier = await membershipTierFor(ctx.user.userId);
      if (!meetsRequiredMembershipTier(membershipTier, party.requiredMembershipTier) || !meetsRequiredMembershipTier(membershipTier, ticketTier.requiredMembershipTier)) {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'Your membership tier does not meet this Party ticket requirement.' });
      }
      if (knownGuest?.status === 'declined') throw new TRPCError({ code: 'FORBIDDEN', message: 'The host has declined this Party request.' });
      if (knownGuest?.status === 'refund-required') throw new TRPCError({ code: 'CONFLICT', message: 'This checkout requires a host refund before another ticket can be requested.' });
      if (knownGuest?.accessGranted) throw new TRPCError({ code: 'CONFLICT', message: 'This Party Pass is already confirmed.' });
      if (!config.stripeSecretKey) throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'Party Checkout is not configured.' });

      const now = new Date();
      const reservation = await serializableTransaction(async (tx) => {
        const existing = await tx.partyCheckout.findUnique({ where: { partyId_userId_idempotencyKey: { partyId: party.id, userId: ctx.user.userId, idempotencyKey: input.idempotencyKey } } });
        if (existing) {
          if (existing.ticketTierName !== ticketTier.name || existing.amountCents !== ticketTier.priceCents || existing.currency !== 'usd') throw new TRPCError({ code: 'CONFLICT', message: 'This checkout retry does not match its original ticket tier.' });
          if (existing.status === 'completed') throw new TRPCError({ code: 'CONFLICT', message: 'This ticket is already confirmed.' });
          if (existing.status === 'expired') throw new TRPCError({ code: 'CONFLICT', message: 'This Checkout expired. Start a new checkout.' });
          return existing;
        }

        const guest = await tx.partyGuest.findUnique({ where: { partyId_userId: { partyId: party.id, userId: ctx.user.userId } } });
        if (guest?.status === 'declined') throw new TRPCError({ code: 'FORBIDDEN', message: 'The host has declined this Party request.' });
        if (guest?.status === 'refund-required') throw new TRPCError({ code: 'CONFLICT', message: 'This checkout requires a host refund before another ticket can be requested.' });
        if (guest?.accessGranted) throw new TRPCError({ code: 'CONFLICT', message: 'This Party Pass is already confirmed.' });
        await tx.partyCheckout.updateMany({
          where: { partyId: party.id, userId: ctx.user.userId, status: { in: ['creating', 'pending'] }, reservationExpiresAt: { lte: now } },
          data: { status: 'expired' },
        });
        const existingActiveCheckout = await tx.partyCheckout.findFirst({
          where: { partyId: party.id, userId: ctx.user.userId, status: { in: ['creating', 'pending'] }, reservationExpiresAt: { gt: now } },
          orderBy: { createdAt: 'desc' },
        });
        if (existingActiveCheckout) throw new TRPCError({ code: 'CONFLICT', message: 'An active checkout already exists for this Party.' });

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
      }, 'Party ticket inventory changed. Please retry.');

      if (reservation.checkoutUrl && reservation.status === 'pending') return { url: reservation.checkoutUrl };
      const stripe = new Stripe(config.stripeSecretKey);
      const session = await stripe.checkout.sessions.create({
        mode: 'payment',
        payment_method_types: ['card'],
        line_items: [{
          price_data: {
            currency: 'usd',
            unit_amount: reservation.amountCents,
            product_data: { name: `${party.title} · ${reservation.ticketTierName}`, description: party.tagline },
          },
          quantity: 1,
        }],
        metadata: { kind: 'party-ticket', checkoutId: reservation.id, partyId: party.id, userId: ctx.user.userId, ticketTierName: reservation.ticketTierName, idempotencyKey: input.idempotencyKey },
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