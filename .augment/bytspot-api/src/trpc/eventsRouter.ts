/**
 * Events sub-router — Phase 2: Events API
 * Proxies and caches Ticketmaster Discovery API for Atlanta area events.
 * Falls back to curated static events when API key is not configured.
 */
import { z } from 'zod';
import { router, publicProcedure, protectedProcedure, rateLimitMiddleware } from './trpc';
import { db } from '../lib/db';
import { discoverablePartyWhere, filterDiscoverableParties, type DiscoverablePartyFacts } from '../services/primePathCandidates';
import { capabilityForAccessMode } from '../services/bookableProjection';
import { distanceMeters } from '../services/checkinProof';
import { boundingBoxWhere } from '../services/geoBox';
import { membershipTierRank, meetsRequiredMembershipTier } from '../lib/membershipTier';

const METERS_PER_MILE = 1609.344;

/** Null when the Party has no coordinate: not a distance of zero, which would
 *  sort an unlocated Party to the top as though it were underfoot. */
function partyDistanceMiles(fromLat: number, fromLng: number, lat: number | null, lng: number | null): number | null {
  if (lat === null || lng === null) return null;
  return distanceMeters({ lat: fromLat, lng: fromLng }, { lat, lng }) / METERS_PER_MILE;
}
import { hostDestinationsRouter, partyArrivalRouter, partyControlRouter, partyDraftsRouter, partyInvite, partyMediaRouter, partyPassRouter, partyPublish, partyRecapRouter, partyRsvpRouter, partyTablesRouter, partyTicketsRouter } from './partyRouter';
import { cached } from '../lib/redis';
import { config } from '../config';

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

// ─── Static fallback events (used when Ticketmaster key is not set) ──
const FALLBACK_EVENTS = [
  { id: 'evt1', title: 'Jazz & Blues Night', venue: 'City Winery Atlanta', date: 'Tonight', time: '8:00 PM', category: 'concert', emoji: '🎷', price: '$25', image: 'https://images.unsplash.com/photo-1415201364774-f6f0bb35f28f?w=600', url: '' },
  { id: 'evt2', title: 'Rooftop Thursdays', venue: 'Ponce City Market', date: 'Tonight', time: '7:00 PM', category: 'rooftop', emoji: '🌃', price: 'Free', image: 'https://images.unsplash.com/photo-1560448204-603b3fc33ddc?w=600', url: '' },
  { id: 'evt3', title: 'Happy Hour Specials', venue: 'Stats Brewpub', date: 'Tonight', time: '4–7 PM', category: 'happyhour', emoji: '🍺', price: '$5 drafts', image: 'https://images.unsplash.com/photo-1558642452-9d2a7deb7f62?w=600', url: '' },
  { id: 'evt4', title: 'Stand-Up Comedy', venue: 'Laughing Skull Lounge', date: 'Tonight', time: '9:30 PM', category: 'comedy', emoji: '😂', price: '$15', image: 'https://images.unsplash.com/photo-1527224538127-2104bb71c51b?w=600', url: '' },
  { id: 'evt5', title: 'Art Walk Midtown', venue: 'MOCA GA', date: 'Tonight', time: '6:00 PM', category: 'art', emoji: '🎨', price: 'Free', image: 'https://images.unsplash.com/photo-1536924940846-227afb31e2a5?w=600', url: '' },
  { id: 'evt6', title: 'Sunday Brunch Party', venue: 'The Optimist', date: 'Sunday', time: '11:00 AM', category: 'food', emoji: '🥂', price: '$45', image: 'https://images.unsplash.com/photo-1414235077428-338989a2e8c0?w=600', url: '' },
];

export const eventsRouter = router({
  drafts: partyDraftsRouter,
  hostDestinations: hostDestinationsRouter,
  media: partyMediaRouter,
  recap: partyRecapRouter,
  tables: partyTablesRouter,
  publish: partyPublish,
  invite: partyInvite,
  pass: partyPassRouter,
  arrival: partyArrivalRouter,
  control: partyControlRouter,
  rsvp: partyRsvpRouter,
  tickets: partyTicketsRouter,
  /**
   * Published parties a guest may discover near a point — the browsing entry
   * point that `plans.primePath` only offered to someone who already had a
   * Plan. Without this a host could publish a located party and no guest
   * could find it.
   *
   * Protected because discoverability is membership-gated: tier is a fact
   * about the caller, and an anonymous caller has no tier to meet. Every
   * other eligibility rule comes from the shared gate, so this procedure
   * cannot be the one that forgets a clause.
   */
  nearby: protectedProcedure
    .use(rateLimitMiddleware({ windowMs: 60_000, max: 60, label: 'events-nearby' }))
    .input(z.object({
      lat: z.number().min(-90).max(90),
      lng: z.number().min(-180).max(180),
      radiusMiles: z.number().min(0.5).max(50).optional().default(10),
      limit: z.number().min(1).max(50).optional().default(20),
    }))
    .query(async ({ ctx, input }) => {
      // 0/0 is the placeholder an unresolved location produces, not a place
      // anyone is standing. Answering it would serve Gulf of Guinea results.
      if (input.lat === 0 && input.lng === 0) return { parties: [] };
      const now = new Date();
      const gate = discoverablePartyWhere(now);
      const withinBox = boundingBoxWhere(input.lat, input.lng, input.radiusMiles);
      // Who the caller is has to be known before the parties are read, not
      // alongside: tier and circles belong in the query, so a row the caller
      // may never see cannot occupy a slot under `take` and push out one
      // they may. The pure gate still re-checks both.
      const [user, circles] = await Promise.all([
        db.user.findUnique({ where: { id: ctx.user.userId }, select: { membershipTier: true } }),
        db.socialCircleMember.findMany({ where: { userId: ctx.user.userId }, select: { circleId: true } }),
      ]);
      const userTier = user?.membershipTier ?? '';
      const userCircleIds = circles.map((m) => m.circleId);
      const allowedTiers = Object.keys(membershipTierRank).filter((tier) => meetsRequiredMembershipTier(userTier, tier));
      const where = {
        ...gate,
        requiredMembershipTier: { in: allowedTiers },
        AND: [
          ...gate.AND,
          // A Party's own coordinates lead; a bound arrival venue answers
          // for parties published before Parties could carry their own.
          { OR: [withinBox, { lat: null, arrivalVenue: withinBox }] },
          // Open to everyone, or scoped to a circle this caller is in.
          { OR: [{ audienceCircleIds: { isEmpty: true } }, ...(userCircleIds.length > 0 ? [{ audienceCircleIds: { hasSome: userCircleIds } }] : [])] },
        ],
      };
      // The box admits rows the exact radius will reject, so one bounded read
      // can come back entirely corners and answer "nothing nearby" while
      // eligible parties sit just past the cut. Pages are read in the same
      // order, each filtered before the next is asked for, until enough
      // survive or the rows run out. The page budget bounds the work;
      // reaching it truncates the answer rather than corrupting it.
      const PAGE_SIZE = 200;
      const MAX_PAGES = 5;
      const kept: { party: DiscoverablePartyFacts & { venueName: string }; distanceMiles: number }[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < MAX_PAGES && kept.length < input.limit; page += 1) {
        const batch = await db.party.findMany({
          where,
          select: {
            id: true, title: true, capacity: true, status: true, admissionPaused: true,
            closedAt: true, endsAt: true, startsAt: true, accessMode: true,
            requiredMembershipTier: true, audienceCircleIds: true,
            templateId: true, locationDisclosure: true, shareLinkExpiresAt: true,
            venueName: true, lat: true, lng: true,
            arrivalVenue: { select: { lat: true, lng: true } },
          },
          orderBy: [{ startsAt: 'asc' }, { id: 'asc' }],
          take: PAGE_SIZE,
          ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
        });
        if (batch.length === 0) break;
        cursor = batch[batch.length - 1].id;
        const facts: (DiscoverablePartyFacts & { venueName: string })[] = batch.map((p) => ({
          id: p.id, title: p.title, capacity: p.capacity, status: p.status,
          admissionPaused: p.admissionPaused, closedAt: p.closedAt, endsAt: p.endsAt,
          startsAt: p.startsAt, accessMode: p.accessMode,
          requiredMembershipTier: p.requiredMembershipTier,
          audienceCircleIds: p.audienceCircleIds,
          templateId: p.templateId,
          locationDisclosure: p.locationDisclosure,
          shareLinkExpiresAt: p.shareLinkExpiresAt,
          latitude: p.lat ?? p.arrivalVenue?.lat ?? null,
          longitude: p.lng ?? p.arrivalVenue?.lng ?? null,
          venueName: p.venueName,
        }));
        const eligible = filterDiscoverableParties(facts, {
          userTier,
          userCircleIds: new Set(userCircleIds),
          attachedPartyIds: new Set<string>(),
          now,
        }) as (DiscoverablePartyFacts & { venueName: string })[];
        for (const party of eligible) {
          const distance = partyDistanceMiles(input.lat, input.lng, party.latitude, party.longitude);
          if (distance !== null && distance <= input.radiusMiles) kept.push({ party, distanceMiles: distance });
        }
        if (batch.length < PAGE_SIZE) break;
      }
      // Pages arrive in start order and are filtered in place, so `kept` is
      // already ordered; the sort restates that rather than relying on it.
      // Trimming before the occupancy read keeps it to what is answered.
      const answering = kept
        .sort((a, b) => a.party.startsAt.getTime() - b.party.startsAt.getTime() || a.party.id.localeCompare(b.party.id))
        .slice(0, input.limit);
      const granted = answering.length > 0
        ? await db.partyGuest.groupBy({ by: ['partyId'], where: { partyId: { in: answering.map((row) => row.party.id) }, accessGranted: true }, _count: { _all: true } })
        : [];
      const grantedMap = new Map(granted.map((row) => [row.partyId, row._count._all]));
      const parties = answering
        .map(({ party, distanceMiles: distance }) => ({
          id: party.id,
          title: party.title,
          venueName: party.venueName,
          startsAt: party.startsAt.toISOString(),
          endsAt: party.endsAt?.toISOString() ?? null,
          accessMode: party.accessMode,
          capability: capabilityForAccessMode(party.accessMode),
          requiredMembershipTier: party.requiredMembershipTier,
          latitude: party.latitude,
          longitude: party.longitude,
          distanceMiles: Math.round(distance * 10) / 10,
          // Seats are live occupancy, never Typical. A party whose capacity
          // is already met still shows, so a guest is not told a party does
          // not exist when it is simply full.
          capacity: party.capacity,
          spacesRemaining: Math.max(0, party.capacity - (grantedMap.get(party.id) ?? 0)),
        }));
      return { parties };
    }),

  /** List events near Atlanta (cached 15 min) */
  list: publicProcedure
    .input(z.object({
      category: z.string().optional(),
      limit: z.number().min(1).max(50).optional().default(20),
    }).optional().default({}))
    .query(async ({ input }) => {
      const { category, limit } = input;

      if (!config.ticketmasterApiKey) {
        // No API key — return curated fallback
        let events = FALLBACK_EVENTS;
        if (category) events = events.filter((e) => e.category === category);
        return { events: events.slice(0, limit), source: 'fallback' as const };
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
          return FALLBACK_EVENTS;
        }
        const data = (await res.json()) as { _embedded?: { events?: TmEvent[] } };
        const raw: TmEvent[] = data._embedded?.events ?? [];
        return raw.map(mapTmEvent);
      });

      return { events: events ?? FALLBACK_EVENTS, source: 'ticketmaster' as const };
    }),
});

