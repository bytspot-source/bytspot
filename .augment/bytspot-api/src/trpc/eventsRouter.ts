/**
 * Events sub-router — Phase 2: Events API
 * Proxies and caches Ticketmaster Discovery API for Atlanta area events.
 * Returns an empty list when Ticketmaster is not configured.
 */
import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { createHash, randomInt } from 'node:crypto';
import { router, publicProcedure, protectedProcedure, rateLimitMiddleware } from './trpc';
import { cached } from '../lib/redis';
import { config } from '../config';
import { db } from '../lib/db';

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
const ticketTier = z.object({
  name: z.string().trim().min(1).max(80),
  priceCents: z.number().int().min(0).max(10_000_000),
  quantity: z.number().int().min(1).max(100_000),
  requiredMembershipTier: membershipTier,
});
const partyDraftInput = z.object({
  idempotencyKey,
  templateId: z.enum(['listening-party', 'comedy-night', 'premiere', 'private-party', 'fan-meetup']),
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
  source: z.literal('host-studio'),
}).superRefine((input, ctx) => {
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

type PartyDraftInput = z.infer<typeof partyDraftInput>;

function draftFingerprint(input: PartyDraftInput): string {
  const { idempotencyKey: _key, ...draft } = input;
  return createHash('sha256').update(JSON.stringify(draft)).digest('hex');
}

function partyPassCode(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from({ length: 8 }, () => alphabet[randomInt(alphabet.length)]).join('');
}

function publishedParty(party: { id: string; status: string; passCode: string | null }) {
  if (party.status !== 'published' || !party.passCode) {
    throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Party Pass is unavailable.' });
  }
  return {
    id: party.id,
    status: 'published' as const,
    shareUrl: `https://bytspot.com/party/${encodeURIComponent(party.id)}`,
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

export const eventsRouter = router({
  drafts: partyDraftsRouter,

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
      if (party.status === 'published') return publishedParty(party);
      if (party.status !== 'draft') {
        throw new TRPCError({ code: 'CONFLICT', message: 'Only draft parties can be published.' });
      }

      await tx.party.updateMany({
        where: { id: party.id, hostId: ctx.user.userId, idempotencyKey: input.idempotencyKey, status: 'draft' },
        data: { status: 'published', passCode: partyPassCode(), publishedAt: new Date() },
      });
      const published = await tx.party.findUnique({ where: { id: party.id } });
      if (!published) throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Published party could not be loaded.' });
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

