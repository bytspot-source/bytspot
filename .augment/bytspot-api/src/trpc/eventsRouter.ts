/**
 * Events sub-router — Phase 2: Events API
 * Proxies and caches Ticketmaster Discovery API for Atlanta area events.
 * Returns an empty list when Ticketmaster is not configured.
 */
import { z } from 'zod';
import { router, publicProcedure } from './trpc';
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

export const eventsRouter = router({
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

