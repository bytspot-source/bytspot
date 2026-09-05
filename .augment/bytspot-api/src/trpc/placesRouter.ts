/**
 * Places sub-router — Phase 3: Google Places (New) API proxy
 * Proxies Nearby Search, Text Search, Place Details, and Photo URLs
 * with Redis caching to stay within free-tier limits.
 */
import { z } from 'zod';
import { router, publicProcedure } from './trpc';
import { cached, getRedis } from '../lib/redis';
import { captureError } from '../lib/observability';
import { config } from '../config';
import { isPhotoName, photoProxyUrl } from '../routes/placesPhoto';

const GP_BASE = 'https://places.googleapis.com/v1';

/**
 * Bumped when the cached shape changes in a way that must not be served from
 * before the bump. v2 abandons every entry written while photo URLs carried
 * the API key: those objects are still readable for their TTL, and the stale
 * copies for a week, so changing the mapper alone would keep leaking.
 */
const CACHE_VERSION = 'v2';

export const SEARCH_FIELDS = [
  'places.id', 'places.displayName', 'places.formattedAddress', 'places.location',
  'places.rating', 'places.userRatingCount', 'places.priceLevel', 'places.types',
  'places.photos', 'places.currentOpeningHours', 'places.primaryType', 'places.websiteUri',
].join(',');

const DETAIL_FIELDS = [
  'id', 'displayName', 'formattedAddress', 'location', 'rating', 'userRatingCount',
  'priceLevel', 'types', 'photos', 'currentOpeningHours', 'regularOpeningHours',
  'primaryType', 'websiteUri', 'nationalPhoneNumber', 'googleMapsUri',
  'editorialSummary', 'reviews',
].join(',');

export interface MappedPlace {
  placeId: string; name: string; address: string; lat: number; lng: number;
  rating: number | null; ratingCount: number; priceLevel: string | null;
  types: string[]; primaryType: string | null; photoUrls: string[];
  isOpen: boolean | null; websiteUri: string | null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function mapPlace(p: any): MappedPlace {
  // Proxied, never signed. Google's media endpoint takes the API key only as
  // a query parameter, so a directly-fetchable URL would ship the key to every
  // caller of this public procedure.
  const photos: string[] = (p.photos ?? [])
    .slice(0, 4)
    .filter((ph: any) => isPhotoName(ph?.name))
    .map((ph: any) => photoProxyUrl(ph.name));
  return {
    placeId: p.id ?? '', name: p.displayName?.text ?? '',
    address: p.formattedAddress ?? '',
    lat: p.location?.latitude ?? 0, lng: p.location?.longitude ?? 0,
    rating: p.rating ?? null, ratingCount: p.userRatingCount ?? 0,
    priceLevel: p.priceLevel ?? null, types: p.types ?? [],
    primaryType: p.primaryType ?? null, photoUrls: photos,
    isOpen: p.currentOpeningHours?.openNow ?? null, websiteUri: p.websiteUri ?? null,
  };
}

/**
 * Server-side place lookup for binding a Party's arrival destination. Returns
 * only the fields a Venue needs, or null when the key is unset or Google is
 * unreachable — the caller turns null into a NOT_FOUND so an outage degrades to
 * "pick another", never a 500.
 */
export async function resolvePlaceCore(
  placeId: string,
): Promise<Pick<MappedPlace, 'placeId' | 'name' | 'address' | 'lat' | 'lng' | 'primaryType'> | null> {
  if (!config.googlePlacesApiKey) return null;
  try {
    const data = await gpGet<Record<string, unknown>>(`/places/${placeId}`, DETAIL_FIELDS);
    const m = mapPlace(data);
    if (!m.placeId || !m.name) return null;
    return { placeId: m.placeId, name: m.name, address: m.address, lat: m.lat, lng: m.lng, primaryType: m.primaryType };
  } catch (err) {
    captureError(err, { provider: 'google-places', operation: 'resolvePlaceCore' });
    return null;
  }
}

export async function gpPost<T>(path: string, body: object, fieldMask: string): Promise<T> {
  const res = await fetch(`${GP_BASE}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': config.googlePlacesApiKey,
      'X-Goog-FieldMask': fieldMask,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) {
    console.error(`[places] Google ${res.status}: ${await res.text().catch(() => '')}`);
    throw new Error(`Google Places API error ${res.status}`);
  }
  return res.json() as Promise<T>;
}

async function gpGet<T>(path: string, fieldMask: string): Promise<T> {
  // Header, not query string, matching gpPost: a key in a URL rides along
  // into logs and error traces.
  const res = await fetch(`${GP_BASE}${path}`, {
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': config.googlePlacesApiKey,
      'X-Goog-FieldMask': fieldMask,
    },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) {
    console.error(`[places] Google ${res.status}: ${await res.text().catch(() => '')}`);
    throw new Error(`Google Places API error ${res.status}`);
  }
  return res.json() as Promise<T>;
}

/**
 * Google's free tier allows 100 nearby searches per day for the whole
 * project. Keying the cache on a four-decimal coordinate (~11m) gave every
 * device position its own entry, so two people on the same block shared
 * nothing and the day's quota went in minutes.
 *
 * Snapping to ~350m buckets means a corridor costs a handful of calls a day
 * instead of one per user. The bucket is smaller than the smallest search
 * radius, so results stay local to the caller.
 */
export function locationBucket(lat: number, lng: number): string {
  const grid = 0.0032;
  return `${Math.round(lat / grid)}:${Math.round(lng / grid)}`;
}

/**
 * De-duplicated and sorted, so the same set of types asked for in a different
 * order is one cache entry and therefore one billed Google call.
 */
export function mergeIncludedTypes(type: string | undefined, types: string[] | undefined): string[] {
  return [...new Set([...(types ?? []), ...(type ? [type] : [])])].sort();
}

export function nearbySearchCacheKey(
  lat: number,
  lng: number,
  radius: number,
  includedTypes: string[],
  maxResults: number,
): string {
  return `gp:${CACHE_VERSION}:nearby:${locationBucket(lat, lng)}:${radius}:${includedTypes.join('+') || 'all'}:${maxResults}`;
}

/**
 * Google failing must not empty the app.
 *
 * A quota exhaustion or outage used to throw, and Home lost its places
 * entirely. A day-old list of restaurants is still true — they have not moved
 * — so the last good answer is kept well past its freshness window and served
 * when the live call fails. The caller is told the result is stale rather
 * than being allowed to present it as current.
 */
/** Minimal surface used for the stale copy, so tests can supply a fake. */
export interface StaleStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode: 'EX', ttl: number): Promise<unknown>;
}

export async function cachedWithStale<T>(
  key: string,
  ttlSeconds: number,
  fetcher: () => Promise<T>,
  store?: StaleStore | null,
): Promise<{ data: T; stale: boolean }> {
  const staleKey = `${key}:stale`;
  const redis = store ?? (getRedis() as StaleStore | null);
  try {
    const fresh = await cached(key, ttlSeconds, async () => {
      const data = await fetcher();
      if (redis) await Promise.resolve(redis.set(staleKey, JSON.stringify(data), 'EX', STALE_TTL_SECONDS)).catch(() => undefined);
      return data;
    });
    return { data: fresh, stale: false };
  } catch (err) {
    if (redis) {
      const hit = await Promise.resolve(redis.get(staleKey)).catch(() => null);
      if (hit) {
        console.warn(`[places] serving stale ${key}: ${(err as Error).message}`);
        return { data: JSON.parse(hit) as T, stale: true };
      }
    }
    throw err;
  }
}

const STALE_TTL_SECONDS = 7 * 24 * 60 * 60;

export const placesRouter = router({
  nearbySearch: publicProcedure
    .input(z.object({
      lat: z.number(), lng: z.number(),
      radius: z.number().min(100).max(50000).optional().default(2000),
      type: z.string().optional(),
      /// Several types in one call rather than one call per type: Google bills
      /// per request, and a category like coffee spans `coffee_shop` and the
      /// broader `cafe`. Merged with `type` so existing callers are untouched.
      types: z.array(z.string().min(1).max(60)).min(1).max(5).optional(),
      maxResults: z.number().min(1).max(20).optional().default(10),
    }))
    .query(async ({ input }) => {
      const { lat, lng, radius, type, maxResults } = input;
      if (!config.googlePlacesApiKey) return { places: [], source: 'none' as const };
      const includedTypes = mergeIncludedTypes(type, input.types);
      const cacheKey = nearbySearchCacheKey(lat, lng, radius, includedTypes, maxResults);
      try {
        const { data: places, stale } = await cachedWithStale(cacheKey, 900, async () => {
          const body: Record<string, unknown> = {
            locationRestriction: { circle: { center: { latitude: lat, longitude: lng }, radius } },
            maxResultCount: maxResults, rankPreference: 'DISTANCE',
          };
          if (includedTypes.length > 0) body.includedTypes = includedTypes;
          const data = await gpPost<{ places?: unknown[] }>('/places:searchNearby', body, SEARCH_FIELDS);
          return (data.places ?? []).map(mapPlace);
        });
        return { places, source: stale ? ('google-stale' as const) : ('google' as const) };
      } catch (err) {
        // Google being unreachable is not this server malfunctioning, and an
        // empty list is not the same claim as "there is nothing here".
        // 'unavailable' lets the client say it does not know, instead of
        // erroring the tab or implying the area is empty. Reported explicitly
        // because a handled provider outage is invisible to Sentry otherwise.
        captureError(err, { provider: 'google-places', operation: 'nearbySearch' });
        return { places: [] as MappedPlace[], source: 'unavailable' as const };
      }
    }),

  textSearch: publicProcedure
    .input(z.object({
      query: z.string().min(2).max(200),
      maxResults: z.number().min(1).max(20).optional().default(10),
    }))
    .query(async ({ input }) => {
      const { query, maxResults } = input;
      if (!config.googlePlacesApiKey) return { places: [], source: 'none' as const };
      const cacheKey = `gp:${CACHE_VERSION}:text:${query.toLowerCase().trim()}:${maxResults}`;
      try {
        const { data: places, stale } = await cachedWithStale(cacheKey, 900, async () => {
          const body = {
            textQuery: query, maxResultCount: maxResults,
            locationBias: { circle: { center: { latitude: 33.7756, longitude: -84.3963 }, radius: 10000 } },
          };
          const data = await gpPost<{ places?: unknown[] }>('/places:searchText', body, SEARCH_FIELDS);
          return (data.places ?? []).map(mapPlace);
        });
        return { places, source: stale ? ('google-stale' as const) : ('google' as const) };
      } catch (err) {
        captureError(err, { provider: 'google-places', operation: 'textSearch' });
        return { places: [] as MappedPlace[], source: 'unavailable' as const };
      }
    }),

  details: publicProcedure
    .input(z.object({ placeId: z.string() }))
    .query(async ({ input }) => {
      if (!config.googlePlacesApiKey) return { place: null };
      const cacheKey = `gp:${CACHE_VERSION}:detail:${input.placeId}`;
      const place = await cached(cacheKey, 3600, async () => {
        const data = await gpGet<Record<string, unknown>>(`/places/${input.placeId}`, DETAIL_FIELDS);
        const mapped = mapPlace(data);
        return {
          ...mapped,
          phone: (data.nationalPhoneNumber as string) ?? null,
          googleMapsUrl: (data.googleMapsUri as string) ?? null,
          editorialSummary: (data.editorialSummary as { text?: string })?.text ?? null,
          openingHours: (data.regularOpeningHours as { weekdayDescriptions?: string[] })?.weekdayDescriptions ?? [],
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          reviews: ((data.reviews as Array<any>) ?? []).slice(0, 5).map((r: any) => ({
            rating: r.rating ?? 0, text: r.text?.text ?? '',
            author: r.authorAttribution?.displayName ?? 'Anonymous',
            timeAgo: r.relativePublishTimeDescription ?? '',
          })),
        };
      });
      return { place };
    }),

  photoUrl: publicProcedure
    .input(z.object({ photoName: z.string(), maxWidth: z.number().min(100).max(4800).optional().default(800) }))
    .query(({ input }) => {
      if (!config.googlePlacesApiKey) return { url: null };
      if (!isPhotoName(input.photoName)) return { url: null };
      return { url: photoProxyUrl(input.photoName, input.maxWidth) };
    }),
});