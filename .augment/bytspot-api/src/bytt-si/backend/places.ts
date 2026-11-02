import type { ConciergeSearch, PlacesOutcome } from '../../services/conciergeDiscovery';
import type { DiscoveryRail } from '../../services/discoveryTaxonomy';
import { NO_PREFERENCES, preferenceFit, type PreferenceFilter } from '../../services/preferenceFit';
import type { RecommendPlace } from '../../services/recommendations';
import type { PlaceRecord, PlacesPort } from '../ports/types';

/**
 * PlacesPort over the Release A concierge search (conciergePlaces.ts): the same
 * Google Places text search, Redis cache and stale fallback (`cachedWithStale`),
 * and the same admin-hidden reconciliation discover uses.
 *
 * Never turns a Google price level into a price (founder decision: priceCents
 * stays null without a real source) and never sets crowd (CrowdPort does, Typical only).
 *
 * The guest's saved preferences apply through preferenceFit, as in Home picks
 * and concierge.discover: an avoided type or a listed price above the ceiling
 * is left out; an unlisted price is kept.
 */
export interface PlacesAdapterDeps {
  search(search: ConciergeSearch): Promise<PlacesOutcome>;
  reconcile(places: RecommendPlace[]): Promise<{ hiddenPlaceIds: string[] }>;
  /** Saved preferences for the requesting guest. Read once per port; a failure applies none. */
  preferences?: () => Promise<PreferenceFilter>;
}

export const NEED_RAIL: Record<string, DiscoveryRail> = {
  dining: 'eat_drink', coffee: 'eat_drink', drinks: 'nightlife', nightlife: 'nightlife', event: 'events', activity: 'experience',
};

/** Same character rules as conciergeSearchSchema.query; falls back to the need itself. */
export function sanitizeQuery(raw: string, fallback: string): string {
  const cleaned = raw.replace(/[^\p{L}\p{N} &'’.-]+/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 120).trim();
  return cleaned || fallback;
}

export function createBackendPlacesPort(deps: PlacesAdapterDeps): PlacesPort {
  let saved: Promise<PreferenceFilter> | null = null;
  const preferences = () => (saved ??= deps.preferences ? deps.preferences().catch(() => NO_PREFERENCES) : Promise.resolve(NO_PREFERENCES));
  return {
    async search(q) {
      const search: ConciergeSearch = {
        query: sanitizeQuery(q.query, q.needKind),
        rail: NEED_RAIL[q.needKind] ?? 'explore',
        mode: 'category',
        location: { lat: q.latitude, lng: q.longitude },
        // Same bounds conciergeSearchSchema enforces; the radius is server-owned.
        radius: Math.min(5000, Math.max(400, Math.round(q.radiusMeters))),
      };
      try {
        const outcome = await deps.search(search);
        if (outcome.source === 'unavailable' || outcome.source === 'none') return { places: [], source: outcome.source };
        const [{ hiddenPlaceIds }, filter] = await Promise.all([deps.reconcile(outcome.places), preferences()]);
        const hidden = new Set(hiddenPlaceIds);
        const visible = outcome.places.filter((p) => !hidden.has(p.placeId.replace(/^places\//, '')));
        const fitting = visible.filter((p) => preferenceFit({ types: p.types, primaryType: p.primaryType, priceLevel: p.priceLevel }, filter).keep);
        const places: PlaceRecord[] = fitting
          .map((p) => ({
            placeId: p.placeId.replace(/^places\//, ''), name: p.name, address: p.address?.trim() || null,
            latitude: p.lat, longitude: p.lng, types: p.primaryType ? [p.primaryType, ...p.types.filter((t) => t !== p.primaryType)] : p.types,
            rating: p.rating, isOpen: p.isOpen, priceCents: null, priceBasis: null, crowd: null,
          }));
        return { places, source: outcome.source, leftOut: visible.length - fitting.length };
      } catch {
        // A place we cannot check against the hidden list is not shown.
        return { places: [], source: 'unavailable' };
      }
    },
  };
}
