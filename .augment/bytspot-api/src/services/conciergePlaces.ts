import { createHash } from 'node:crypto';
import { z } from 'zod';
import { config } from '../config';
import { cachedWithStale, gpPost, mapPlace } from '../trpc/placesRouter';
import { conciergeSearchSchema, coordinateSchema, withinSearch, type ConciergeSearch, type PlacesOutcome } from './conciergeDiscovery';

/** Spherical circle's bounding rectangle; crossing the date line is explicit.
 * Longitude spans the whole globe only when the small circle contains a pole. */
export function discoveryBounds(location: { lat: number; lng: number }, radius: number) {
  const angular = radius / 6371000;
  const degrees = 180 / Math.PI;
  const lowLat = Math.max(-90, location.lat - angular * degrees);
  const highLat = Math.min(90, location.lat + angular * degrees);
  const allLongitudes = lowLat === -90 || highLat === 90;
  const deltaLng = allLongitudes ? 180 : Math.asin(Math.min(1, Math.sin(angular) / Math.cos(location.lat / degrees))) * degrees;
  const wrap = (lng: number) => ((lng + 540) % 360) - 180;
  return { lowLat, highLat, lowLng: allLongitudes ? -180 : wrap(location.lng - deltaLng),
    highLng: allLongitudes ? 180 : wrap(location.lng + deltaLng) };
}

export function conciergePlacesCacheKey(raw: ConciergeSearch): string {
  const search = conciergeSearchSchema.parse(raw);
  const query = createHash('sha256').update(search.query.toLowerCase().trim()).digest('hex');
  return `gp:concierge:v2:${search.mode}:${search.location.lat}:${search.location.lng}:${search.radius}:${query}:20`;
}

// Text-only: never request photos, reviews, booking links or editorial content.
export const CONCIERGE_PLACE_FIELDS = [
  'places.id', 'places.displayName', 'places.formattedAddress', 'places.location',
  'places.rating', 'places.userRatingCount', 'places.types', 'places.primaryType', 'places.currentOpeningHours',
].join(',');
const rawPlaceSchema = z.object({
  id: z.string().min(1), displayName: z.object({ text: z.string().min(1) }),
  formattedAddress: z.string().optional(),
  location: z.object({ latitude: coordinateSchema.shape.lat, longitude: coordinateSchema.shape.lng }),
  rating: z.number().finite().min(0).max(5).optional(), userRatingCount: z.number().int().min(0).optional(),
  types: z.array(z.string()).optional(), primaryType: z.string().optional(),
  currentOpeningHours: z.object({ openNow: z.boolean().optional() }).optional(),
});

export interface ConciergePlacesDependencies {
  enabled(): boolean;
  post(body: object, fieldMask: string): Promise<{ places?: unknown[] }>;
  cache: typeof cachedWithStale;
}
export function createConciergePlacesSearch(dependencies: ConciergePlacesDependencies) {
  return async (raw: ConciergeSearch): Promise<PlacesOutcome> => {
    const search = conciergeSearchSchema.parse(raw);
    if (!dependencies.enabled()) return { places: [], source: 'none' };
    const bounds = discoveryBounds(search.location, search.radius);
    try {
      const { data, stale } = await dependencies.cache(conciergePlacesCacheKey(search), 900, async () => {
        const found = await dependencies.post({
          textQuery: search.query, maxResultCount: 20,
          ...(search.mode === 'name' ? {
            locationBias: { circle: { center: { latitude: search.location.lat, longitude: search.location.lng }, radius: search.radius } },
          } : {
            locationRestriction: { rectangle: {
              low: { latitude: bounds.lowLat, longitude: bounds.lowLng },
              high: { latitude: bounds.highLat, longitude: bounds.highLng },
            } },
          }),
        }, CONCIERGE_PLACE_FIELDS);
        // mapPlace defaults missing coordinates to zero for legacy callers; never
        // let that default manufacture a position for this location-aware path.
        const places = (found.places ?? []).slice(0, 20).flatMap((p) => {
          const parsed = rawPlaceSchema.safeParse(p);
          return parsed.success ? [mapPlace(parsed.data)] : [];
        });
        if (found.places?.length && !places.length) throw new Error('Invalid Places response');
        return places;
      });
      return { places: data.filter((p) => withinSearch(search.location, { lat: p.lat, lng: p.lng }, search.radius))
        .map((p) => ({ ...p, isOpen: stale ? null : p.isOpen, photoUrls: [], photoAttributions: [] })),
        source: stale ? 'google-stale' : 'google' };
    } catch {
      // No raw content, coordinates, provider body, query or credentials in logs.
      return { places: [], source: 'unavailable' };
    }
  };
}

export const conciergePlacesSearch = createConciergePlacesSearch({
  enabled: () => Boolean(config.googlePlacesApiKey),
  post: (body, fields) => gpPost<{ places?: unknown[] }>('/places:searchText', body, fields),
  cache: cachedWithStale,
});
