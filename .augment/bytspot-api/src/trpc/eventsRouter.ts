/**
 * Events sub-router — Phase 2: Events API
 * Proxies and caches Ticketmaster Discovery API for Atlanta area events.
 * Returns an empty list when Ticketmaster is not configured.
 */
import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { createHash, createHmac, randomInt } from 'node:crypto';
import { router, publicProcedure, protectedProcedure, rateLimitMiddleware } from './trpc';
import { cached } from '../lib/redis';
import { config } from '../config';
import { db } from '../lib/db';
import { uploadPartyImage } from '../lib/cloudinary';

// ─── Ticketmaster Discovery API helpers ─────────────────────────────
const TM_BASE = 'https://app.ticketmaster.com/discovery/v2';

interface TmEvent {
  id: string;
  name: string;
  url: string;
  dates?: { start?: { localDate?: string; localTime?: string } };
  priceRanges?: Array<{ min: number; max: number; currency: string }>;
  images?: Array<{ url: string; width: number; ratio: string }>;
  classifications?: Array<{ segment?: { name: string }; genre?: { name: string } }>;
  _embedded?: { venues?: Array<{ name: string; city?: { name: string }; address?: { line1: string } }> };
}

export function mapTmEvent(e: TmEvent) {
  const venue = e._embedded?.venues?.[0];
  const img = e.images?.find((i) => i.ratio === '16_9' && i.width >= 500) ?? e.images?.[0];
  const price = e.priceRanges?.[0];
  const genre = e.classifications?.[0]?.genre?.name ?? e.classifications?.[0]?.segment?.name ?? 'event';
  const categoryMap: Record<string, string> = {
    Jazz: 'concert', Rock: 'concert', Pop: 'concert', 'Hip-Hop/Rap': 'concert', 'R&B': 'concert',
    Comedy: 'comedy', Arts: 'art', Theatre: 'art', Sports: 'sports', Food: 'food',
  };
  return {
    id: e.id,
    title: e.name,
    venue: venue?.name ?? 'Atlanta Venue',
    date: e.dates?.start?.localDate ?? 'TBD',
    time: e.dates?.start?.localTime?.slice(0, 5) ?? 'TBD',
    category: categoryMap[genre] ?? 'concert',
    emoji: categoryEmoji(categoryMap[genre] ?? 'concert'),
    price: price ? (price.min === 0 ? 'Free' : `$${price.min}`) : 'See link',
    image: img?.url ?? 'https://images.unsplash.com/photo-1415201364774-f6f0bb35f28f?w=600',
    url: e.url,
  };
}

function categoryEmoji(cat: string): string {
  const map: Record<string, string> = {
    concert: '🎵', rooftop: '🌃', happyhour: '🍺', comedy: '😂',
    art: '🎨', food: '🍽️', sports: '⚽',
  };
  return map[cat] ?? '🎉';
}

const membershipTier = z.enum(['green', 'platinum', 'black']);
const tierRank = { green: 0, platinum: 1, black: 2 } as const;
const idempotencyKey = z.string().min(8).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const partyTemplateId = z.enum(['listening-party', 'comedy-night', 'premiere', 'private-party', 'fan-meetup', 'release-party', 'pop-up']);
const partyTemplateConfig = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('standard') }).strict(),
  z.object({ kind: z.literal('listening-party'), format: z.enum(['listening-session', 'dj-mix-premiere', 'live-performance', 'label-showcase']) }).strict(),
  z.object({ kind: z.literal('fan-meetup'), format: z.enum(['meet-and-greet', 'creator-conversation', 'community-photo']) }).strict(),
  z.object({ kind: z.literal('release-party'), releaseType: z.enum(['single', 'ep', 'album', 'mix', 'video']), releaseTitle: z.string().trim().min(1).max(120) }).strict(),
  z.object({ kind: z.literal('pop-up'), locationDisclosure: z.enum(['public', 'after-approval']) }).strict(),
  z.object({ kind: z.literal('private-party'), guestPolicy: z.enum(['named-guests', 'named-guests-plus-one']) }).strict(),
]);
const templateConfigKind: Record<z.infer<typeof partyTemplateId>, z.infer<typeof partyTemplateConfig>['kind']> = {
  'listening-party': 'listening-party',
  'fan-meetup': 'fan-meetup',
  'release-party': 'release-party',
  'pop-up': 'pop-up',
  'private-party': 'private-party',
  'comedy-night': 'standard',
  premiere: 'standard',
};
const partyPassAction = z.enum(['rsvp', 'ticket', 'claim-invitation', 'unavailable']);
const partyPassPolicy = z.object({
  version: z.literal(1),
  before: z.object({ action: partyPassAction }).strict(),
  atDoor: z.object({ action: partyPassAction }).strict(),
  during: z.object({ action: partyPassAction }).strict(),
  after: z.object({ action: partyPassAction }).strict(),
}).strict();
const ticketTier = z.object({
  name: z.string().trim().min(1).max(80),
  priceCents: z.number().int().min(0).max(10_000_000),
  quantity: z.number().int().min(1).max(100_000),
  requiredMembershipTier: membershipTier,
});
const partyDraftInput = z.object({
  idempotencyKey,
  templateId: partyTemplateId,
  title: z.string().trim().min(3).max(200),
  tagline: z.string().trim().max(280),
  startsAt: z.string().datetime(),
  venueName: z.string().trim().min(1).max(200),
  capacity: z.number().int().min(2).max(100_000),
  accessMode: z.enum(['free-rsvp', 'paid-ticket', 'private-approval']),
  requiredMembershipTier: membershipTier,
  audienceCircleIds: z.array(z.string().min(1).max(200)).max(100),
  itinerary: z.array(z.object({
    title: z.string().trim().min(1).max(160),
    offsetMinutes: z.number().int().min(0).max(10_080),
  })).max(50),
  ticketTiers: z.array(ticketTier).max(20),
  cohosts: z.array(z.object({
    email: z.string().trim().email().max(320).transform((email) => email.toLowerCase()),
    role: z.enum(['cohost', 'door', 'finance']),
  })).max(20),
  templateConfig: partyTemplateConfig,
  source: z.literal('host-studio'),
}).superRefine((input, ctx) => {
  if (input.templateConfig.kind !== templateConfigKind[input.templateId]) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['templateConfig', 'kind'], message: 'The template configuration does not match this Party template.' });
  }
  if (input.templateConfig.kind === 'private-party' && input.accessMode !== 'private-approval') {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['accessMode'], message: 'Private Parties require host approval.' });
  }
  if (input.templateConfig.kind === 'pop-up' && input.templateConfig.locationDisclosure === 'after-approval' && input.accessMode !== 'private-approval') {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['accessMode'], message: 'A hidden Pop-Up location requires host approval.' });
  }
  const paidTiers = input.ticketTiers.filter((tier) => tier.priceCents > 0);
  if (input.accessMode === 'paid-ticket' && paidTiers.length === 0) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['ticketTiers'], message: 'Paid parties require a paid ticket tier.' });
  }
  if (input.accessMode !== 'paid-ticket' && paidTiers.length > 0) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['ticketTiers'], message: 'Only paid parties may include paid ticket tiers.' });
  }
  if (input.ticketTiers.reduce((total, tier) => total + tier.quantity, 0) > input.capacity) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['ticketTiers'], message: 'Ticket inventory cannot exceed party capacity.' });
  }
  for (const [index, tier] of input.ticketTiers.entries()) {
    if (tierRank[tier.requiredMembershipTier] < tierRank[input.requiredMembershipTier]) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['ticketTiers', index, 'requiredMembershipTier'], message: 'A ticket tier cannot bypass the party membership gate.' });
    }
  }
  const teammateEmails = input.cohosts.map((cohost) => cohost.email);
  if (new Set(teammateEmails).size !== teammateEmails.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['cohosts'], message: 'Each teammate may be assigned only once.' });
  }
});

// Keep each JSON request below the server's 1 MB parser limit. The iOS client
// downsizes and recompresses selected images before sending them.
const imageDataUri = z.string().max(850_000).regex(/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/);
const partyMediaUploadInput = z.discriminatedUnion('kind', [
  z.object({ partyId: z.string().min(1).max(200), kind: z.literal('cover'), dataUri: imageDataUri }),
  z.object({ partyId: z.string().min(1).max(200), kind: z.literal('album'), index: z.number().int().min(0).max(5), dataUri: imageDataUri }),
]);

type PartyDraftInput = z.infer<typeof partyDraftInput>;
type PartyPassPolicy = z.infer<typeof partyPassPolicy>;
type PartyPassAction = z.infer<typeof partyPassAction>;

const templateLabels: Record<string, string> = {
  'listening-party': 'Listening Party',
  'comedy-night': 'Comedy Night',
  premiere: 'Premiere',
  'private-party': 'Private Party',
  'fan-meetup': 'Fan Meetup',
  'release-party': 'Release Party',
  'pop-up': 'Pop-Up',
};

function draftFingerprint(input: PartyDraftInput): string {
  const { idempotencyKey: _key, ...draft } = input;
  return createHash('sha256').update(JSON.stringify(draft)).digest('hex');
}

function partyPassCode(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from({ length: 8 }, () => alphabet[randomInt(alphabet.length)]).join('');
}

function partyTouchpointReference(partyID: string): string {
  return `p1_${createHmac('sha256', config.jwtSecret).update(`party-touchpoint:${partyID}`).digest('base64url')}`;
}

function defaultPartyPassPolicy(accessMode: string): PartyPassPolicy {
  const action: PartyPassAction = accessMode === 'paid-ticket'
    ? 'ticket'
    : accessMode === 'private-approval'
      ? 'claim-invitation'
      : 'rsvp';
  return {
    version: 1,
    before: { action },
    atDoor: { action: 'unavailable' },
    during: { action: 'unavailable' },
    after: { action: 'unavailable' },
  };
}

function readPartyPassPolicy(value: unknown): PartyPassPolicy {
  const parsed = partyPassPolicy.safeParse(value);
  return parsed.success
    ? parsed.data
    : { version: 1, before: { action: 'unavailable' }, atDoor: { action: 'unavailable' }, during: { action: 'unavailable' }, after: { action: 'unavailable' } };
}

function partyLocationForPublicInvite(party: { venueName: string; templateConfig: unknown }) {
  const config = partyTemplateConfig.safeParse(party.templateConfig);
  const locationDisclosure = config.success && config.data.kind === 'pop-up'
    ? config.data.locationDisclosure
    : 'public' as const;
  return {
    locationDisclosure,
    locationLabel: locationDisclosure === 'after-approval' ? 'Location shared after approval' : party.venueName,
  };
}

function partyTiming(startsAt: Date): 'now' | 'today' | 'thisWeek' {
  const delta = startsAt.getTime() - Date.now();
  if (Math.abs(delta) <= 2 * 60 * 60 * 1000) return 'now';
  if (delta <= 24 * 60 * 60 * 1000) return 'today';
  return 'thisWeek';
}

function itineraryTitles(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const title = (item as { title?: unknown }).title;
    return typeof title === 'string' && title.trim() ? [title.trim()] : [];
  });
}

function publishedParty(party: { id: string; status: string; passCode: string | null }) {
  if (party.status !== 'published' || !party.passCode) {
    throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Party Pass is unavailable.' });
  }
  return {
    id: party.id,
    status: 'published' as const,
    shareUrl: `https://bytspot.app/party/${encodeURIComponent(party.id)}`,
    passCode: party.passCode,
  };
}

const partyDraftsRouter = router({
  create: protectedProcedure
    .use(rateLimitMiddleware({ windowMs: 60_000, max: 20, label: 'events:drafts:create' }))
    .input(partyDraftInput)
    .mutation(async ({ ctx, input }) => {
      const hostId = ctx.user.userId;
      if (input.cohosts.some((cohost) => cohost.email === ctx.user.email.toLowerCase())) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'The party owner cannot also be assigned as a teammate.' });
      }
      const fingerprint = draftFingerprint(input);
      const party = await db.party.upsert({
        where: { hostId_idempotencyKey: { hostId, idempotencyKey: input.idempotencyKey } },
        create: {
          hostId,
          idempotencyKey: input.idempotencyKey,
          draftFingerprint: fingerprint,
          templateId: input.templateId,
          title: input.title,
          tagline: input.tagline,
          startsAt: new Date(input.startsAt),
          venueName: input.venueName,
          capacity: input.capacity,
          accessMode: input.accessMode,
          requiredMembershipTier: input.requiredMembershipTier,
          audienceCircleIds: input.audienceCircleIds,
          itinerary: input.itinerary,
          ticketTiers: input.ticketTiers,
          cohosts: input.cohosts,
          templateConfig: input.templateConfig,
          source: input.source,
        },
        update: {},
      });
      if (party.draftFingerprint !== fingerprint) {
        throw new TRPCError({ code: 'CONFLICT', message: 'That idempotency key belongs to a different party draft.' });
      }
      return { id: party.id, status: party.status };
    }),
});

const partyMediaRouter = router({
  reset: protectedProcedure
    .use(rateLimitMiddleware({ windowMs: 60_000, max: 20, label: 'events:media:reset' }))
    .input(z.object({ partyId: z.string().min(1).max(200) }))
    .mutation(async ({ ctx, input }) => {
      const party = await db.party.findUnique({ where: { id: input.partyId } });
      if (!party) throw new TRPCError({ code: 'NOT_FOUND', message: 'Party draft not found.' });
      if (party.hostId !== ctx.user.userId) throw new TRPCError({ code: 'FORBIDDEN', message: 'Only the party owner can reset media.' });
      if (party.status !== 'draft') throw new TRPCError({ code: 'CONFLICT', message: 'Published Party media is immutable.' });
      await db.party.update({ where: { id: party.id }, data: { coverImageUrl: null, photoUrls: [] } });
      return { status: 'ready' as const };
    }),
  upload: protectedProcedure
    .use(rateLimitMiddleware({ windowMs: 60_000, max: 20, label: 'events:media:upload' }))
    .input(partyMediaUploadInput)
    .mutation(async ({ ctx, input }) => {
      const party = await db.party.findUnique({ where: { id: input.partyId } });
      if (!party) throw new TRPCError({ code: 'NOT_FOUND', message: 'Party draft not found.' });
      if (party.hostId !== ctx.user.userId) throw new TRPCError({ code: 'FORBIDDEN', message: 'Only the party owner can upload media.' });
      if (party.status !== 'draft') throw new TRPCError({ code: 'CONFLICT', message: 'Published Party media cannot be replaced here.' });
      if (input.kind === 'album' && input.index > party.photoUrls.length) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'Album photos must be uploaded in order.' });
      }
      const slot = input.kind === 'cover' ? 'cover' : `album-${input.index}`;
      const url = await uploadPartyImage(input.dataUri, `bytspot/parties/${party.id}/${slot}`);
      if (input.kind === 'cover') {
        await db.party.update({ where: { id: party.id }, data: { coverImageUrl: url } });
      } else {
        const photoUrls = [...party.photoUrls];
        photoUrls[input.index] = url;
        await db.party.update({ where: { id: party.id }, data: { photoUrls } });
      }
      return { kind: input.kind, url, index: input.kind === 'album' ? input.index : null };
    }),
});

export const eventsRouter = router({
  drafts: partyDraftsRouter,
  media: partyMediaRouter,

  /** Public invite details for an unguessable, published Party Pass URL. */
  invite: publicProcedure
    .use(rateLimitMiddleware({ windowMs: 60_000, max: 120, label: 'events:invite' }))
    .input(z.object({ partyId: z.string().min(1).max(200) }))
    .query(async ({ input }) => {
      const party = await db.party.findUnique({
        where: { id: input.partyId },
        include: { host: { select: { name: true } } },
      });
      if (!party || party.status !== 'published') {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Party invite not found.' });
      }
      // Legacy GroupEventGuest rows are not Party participation. Party-specific
      // guest state is introduced only through Party Pass actions.
      const participantCount = 0;
      const highlights = itineraryTitles(party.itinerary);
      const location = partyLocationForPublicInvite(party);
      return {
        id: party.id,
        source: 'host-studio-party' as const,
        title: party.title,
        inviteNote: party.tagline || null,
        tier: party.requiredMembershipTier,
        timing: partyTiming(party.startsAt),
        participantCount,
        capacity: party.capacity,
        accessMode: party.accessMode,
        groupType: templateLabels[party.templateId] ?? 'Private Party',
        scheduledDate: party.startsAt.toISOString(),
        hostName: party.host.name ?? 'Bytspot Host',
        locationLabel: location.locationLabel,
        locationDisclosure: location.locationDisclosure,
        theme: party.tagline || (templateLabels[party.templateId] ?? 'Private Party'),
        guestSummary: participantCount === 0 ? `Be first to join · ${party.capacity} spots` : `${participantCount} joined · ${party.capacity} spots`,
        activityHighlights: highlights,
        audienceCircle: party.audienceCircleIds.length > 0 ? 'Selected Circles' : 'Shared Party Pass',
        privacyStatus: party.audienceCircleIds.length > 0 || party.accessMode === 'private-approval' ? 'privateInvite' : 'publicDiscovery',
        requiresApproval: party.accessMode === 'private-approval',
        heroImageURL: party.coverImageUrl,
        thumbnailURL: party.coverImageUrl,
        photoURLs: party.photoUrls,
      };
    }),

  /** Resolve a stable Living Party Pass touchpoint. Unknown or unconfigured states fail closed. */
  pass: router({
    resolve: publicProcedure
      .use(rateLimitMiddleware({ windowMs: 60_000, max: 60, label: 'events:pass:resolve' }))
      .input(z.object({ touchpointRef: z.string().min(16).max(200) }))
      .query(async ({ ctx, input }) => {
        const touchpoint = await db.partyTouchpoint.findUnique({ where: { reference: input.touchpointRef }, include: { party: true } });
        if (!touchpoint || touchpoint.status !== 'active' || touchpoint.party.status !== 'published') {
          throw new TRPCError({ code: 'NOT_FOUND', message: 'Party Pass not found.' });
        }

        const lifecycle = touchpoint.party.startsAt.getTime() > Date.now() ? 'before' : 'at-door';
        const policy = readPartyPassPolicy(touchpoint.lifecyclePolicy);
        const action = lifecycle === 'before' ? policy.before.action : 'unavailable';
        const canStartPrimaryAction = action === 'rsvp' || action === 'ticket';

        return {
          partyId: touchpoint.partyId,
          touchpoint: { reference: touchpoint.reference, kind: touchpoint.kind },
          lifecycle,
          action,
          guest: {
            status: ctx.user ? 'authenticated-unverified' as const : 'anonymous' as const,
            canStartPrimaryAction,
            accessGranted: false,
          },
        };
      }),
  }),

  /** Publish is an owner capability. Replays return the original Party Pass. */
  publish: protectedProcedure
    .use(rateLimitMiddleware({ windowMs: 60_000, max: 20, label: 'events:publish' }))
    .input(z.object({ partyId: z.string().min(1).max(200), idempotencyKey }))
    .mutation(async ({ ctx, input }) => db.$transaction(async (tx) => {
      const party = await tx.party.findUnique({ where: { id: input.partyId } });
      if (!party) throw new TRPCError({ code: 'NOT_FOUND', message: 'Party not found.' });
      if (party.hostId !== ctx.user.userId) {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'Only the party owner can publish this draft.' });
      }
      if (party.idempotencyKey !== input.idempotencyKey) {
        throw new TRPCError({ code: 'CONFLICT', message: 'The publish key does not match this party draft.' });
      }
      if (party.status !== 'draft') {
        if (party.status !== 'published') {
          throw new TRPCError({ code: 'CONFLICT', message: 'Only draft parties can be published.' });
        }
      }

      let published = party;
      if (party.status === 'draft') {
        await tx.party.updateMany({
          where: { id: party.id, hostId: ctx.user.userId, idempotencyKey: input.idempotencyKey, status: 'draft' },
          data: { status: 'published', passCode: partyPassCode(), publishedAt: new Date() },
        });
        const reloaded = await tx.party.findUnique({ where: { id: party.id } });
        if (!reloaded) throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Published party could not be loaded.' });
        published = reloaded;
      }
      await tx.partyTouchpoint.upsert({
        where: { partyId_kind: { partyId: published.id, kind: 'digital' } },
        create: {
          partyId: published.id,
          reference: partyTouchpointReference(published.id),
          kind: 'digital',
          lifecyclePolicy: defaultPartyPassPolicy(published.accessMode),
        },
        update: {},
      });
      return publishedParty(published);
    })),

  /** List events near Atlanta (cached 15 min) */
  list: publicProcedure
    .input(z.object({
      category: z.string().optional(),
      limit: z.number().min(1).max(50).optional().default(20),
    }).optional().default({}))
    .query(async ({ input }) => {
      const { category, limit } = input;

      if (!config.ticketmasterApiKey) {
        return { events: [], source: 'unavailable' as const };
      }

      const cacheKey = `events:atl:${category ?? 'all'}:${limit}`;
      const events = await cached(cacheKey, 900, async () => {
        const params = new URLSearchParams({
          apikey: config.ticketmasterApiKey,
          city: 'Atlanta',
          stateCode: 'GA',
          size: String(limit),
          sort: 'date,asc',
        });
        if (category) {
          const segmentMap: Record<string, string> = {
            concert: 'Music', comedy: 'Arts & Theatre', art: 'Arts & Theatre',
            sports: 'Sports', food: 'Miscellaneous',
          };
          if (segmentMap[category]) params.set('segmentName', segmentMap[category]);
        }

        const res = await fetch(`${TM_BASE}/events.json?${params}`, { signal: AbortSignal.timeout(8000) });
        if (!res.ok) {
          console.error(`[events] Ticketmaster ${res.status}: ${await res.text().catch(() => '')}`);
          return [];
        }
        const data = (await res.json()) as { _embedded?: { events?: TmEvent[] } };
        const raw: TmEvent[] = data._embedded?.events ?? [];
        return raw.map(mapTmEvent);
      });

      return { events: events ?? [], source: 'ticketmaster' as const };
    }),
});

