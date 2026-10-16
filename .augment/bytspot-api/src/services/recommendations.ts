/**
 * Recommendations for a guest from their onboarding answers and where they
 * are. Pure ranking only: the caller supplies Google places and Bytspot venues
 * already fetched, so this file has no network or database access.
 *
 * Every reason shown to a guest is derived from data on the candidate (its
 * type, rating, opening state, distance, crowd reading). Nothing is invented.
 */
import { isLiveOccupancySource } from './typicalOccupancy';

/** Google place groups fetched separately, so one category cannot crowd out another. */
export const RECOMMEND_POOLS = {
  eat: ['restaurant'],
  drink: ['bar', 'night_club', 'pub', 'wine_bar'],
  cafe: ['bakery', 'cafe', 'coffee_shop'],
  explore: ['art_gallery', 'museum', 'park', 'performing_arts_theater', 'tourist_attraction'],
} as const;

export type RecommendPool = keyof typeof RECOMMEND_POOLS;

interface VibeProfile {
  pools: RecommendPool[];
  /** Types that make a place a direct match for the vibe. */
  preferred: string[];
  /** Words matched against a Bytspot venue's free-text category. */
  categories: string[];
  label: string;
}

export type ResolvedVibe = VibeProfile & { key: string };

const VIBES: Record<string, VibeProfile> = {
  drinks: { pools: ['drink'], preferred: ['bar', 'cocktail_bar', 'night_club', 'pub', 'wine_bar', 'lounge_bar', 'sports_bar'], categories: ['bar', 'nightlife', 'cocktail', 'club', 'lounge'], label: 'drinks' },
  coffee: { pools: ['cafe'], preferred: ['coffee_shop', 'cafe', 'bakery', 'tea_house'], categories: ['coffee', 'cafe'], label: 'coffee' },
  food: { pools: ['eat'], preferred: ['restaurant'], categories: ['restaurant', 'dining', 'food', 'market'], label: 'a good meal' },
  work: { pools: ['cafe'], preferred: ['coffee_shop', 'cafe', 'tea_house', 'library'], categories: ['coffee', 'cafe', 'cowork'], label: 'a quiet work spot' },
  events: { pools: ['drink', 'explore'], preferred: ['night_club', 'performing_arts_theater', 'live_music_venue', 'concert_hall', 'event_venue', 'comedy_club'], categories: ['club', 'music', 'event', 'entertainment', 'venue'], label: 'something happening' },
  date: { pools: ['eat', 'drink'], preferred: ['wine_bar', 'cocktail_bar', 'fine_dining_restaurant', 'french_restaurant', 'italian_restaurant', 'restaurant', 'bar'], categories: ['restaurant', 'dining', 'cocktail', 'wine'], label: 'date night' },
  indoor: { pools: ['eat', 'cafe', 'explore'], preferred: ['museum', 'art_gallery', 'cafe', 'coffee_shop', 'restaurant', 'performing_arts_theater'], categories: ['restaurant', 'cafe', 'coffee', 'market', 'museum'], label: 'somewhere indoors' },
};

/** Intents with no place type of their own (parking, rides, stays) get a time-of-day mix. */
export function vibeProfile(vibe: string | undefined, hour: number | undefined): ResolvedVibe {
  const key = (vibe ?? '').toLowerCase();
  if (VIBES[key]) return { ...VIBES[key], key };
  const evening = hour !== undefined && (hour >= 16 || hour < 4);
  return evening
    ? { key: 'general', pools: ['eat', 'drink'], preferred: ['restaurant', 'bar'], categories: ['restaurant', 'bar', 'dining'], label: 'tonight' }
    : { key: 'general', pools: ['cafe', 'eat'], preferred: ['coffee_shop', 'cafe', 'restaurant'], categories: ['coffee', 'cafe', 'restaurant'], label: 'today' };
}

const WALK_RADIUS: Record<string, number> = {
  closest: 800, close: 1200, medium: 2000, parking: 3000, covered: 3000, ride: 5000, far: 5000,
};

export function radiusForWalk(walk: string | undefined): number {
  return WALK_RADIUS[(walk ?? '').toLowerCase()] ?? 2000;
}

/** Google is searched at one of two fixed radii so callers share cached answers. */
export function searchRadiusFor(radius: number): number {
  return radius <= 1500 ? 1500 : 5000;
}

/** ~0.9km cells; the search is centred on the cell so everyone in it shares one call. */
export function recommendCell(lat: number, lng: number): { key: string; lat: number; lng: number } {
  const grid = 0.008;
  const r = Math.round(lat / grid);
  const c = Math.round(lng / grid);
  return { key: `${r}:${c}`, lat: Number((r * grid).toFixed(5)), lng: Number((c * grid).toFixed(5)) };
}

export function distanceMeters(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

export interface RecommendPlace {
  placeId: string; name: string; address: string; lat: number; lng: number;
  rating: number | null; ratingCount: number; priceLevel: string | null;
  types: string[]; primaryType: string | null; photoUrls: string[]; photoAttributions: string[];
  isOpen: boolean | null; websiteUri: string | null;
}

export interface RecommendVenue {
  id: string; slug: string; name: string; address: string; lat: number; lng: number;
  category: string; imageUrl: string | null; googlePlaceId: string | null;
  crowd: { level: number; label: string; source: string | null } | null;
}

export interface RecommendItem {
  /** Our venue id, or `gp:<placeId>` for a Google place. */
  id: string;
  kind: 'venue' | 'place';
  slug: string | null;
  placeId: string | null;
  name: string;
  address: string;
  lat: number;
  lng: number;
  distanceMeters: number;
  walkMinutes: number;
  category: string | null;
  rating: number | null;
  ratingCount: number;
  priceLevel: string | null;
  isOpen: boolean | null;
  photoUrl: string | null;
  photoAttribution: string | null;
  websiteUri: string | null;
  crowd: { level: number; label: string; source: string | null } | null;
  reasons: string[];
  score: number;
}

export interface RecommendInput {
  lat: number; lng: number;
  vibe?: string; walk?: string; group?: string; hour?: number;
}

const WALK_METERS_PER_MINUTE = 80;
const PRICEY = new Set(['PRICE_LEVEL_MODERATE', 'PRICE_LEVEL_EXPENSIVE', 'PRICE_LEVEL_VERY_EXPENSIVE']);
const EXPLORE_TYPES = new Set<string>([...RECOMMEND_POOLS.explore, 'historical_landmark', 'cultural_landmark', 'botanical_garden', 'garden', 'plaza', 'concert_hall', 'live_music_venue', 'event_venue', 'zoo', 'aquarium', 'amusement_park', 'hiking_area', 'national_park', 'market']);

function normName(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/** A Bytspot venue and a Google place are the same spot when the ids match, or the names match within 75m. */
export function sameSpot(v: RecommendVenue, p: RecommendPlace): boolean {
  if (v.googlePlaceId && v.googlePlaceId === p.placeId) return true;
  const a = normName(v.name);
  const b = normName(p.name);
  if (!a || !b) return false;
  return (a === b || b.startsWith(`${a} `) || a.startsWith(`${b} `)) && distanceMeters(v, p) <= 75;
}

/** Pulls thinly reviewed ratings toward 4.0, so 5★ from three people does not beat 4.7★ from nine hundred. */
function bayesRating(rating: number, count: number): number {
  return (rating * count + 4.0 * 50) / (count + 50);
}

function crowdReason(crowd: RecommendItem['crowd']): string | null {
  if (!crowd?.label) return null;
  return isLiveOccupancySource(crowd.source) ? `${crowd.label} right now` : `Usually ${crowd.label.toLowerCase()} now`;
}

function distanceReason(meters: number): string {
  const mins = Math.max(1, Math.round(meters / WALK_METERS_PER_MINUTE));
  return mins <= 25 ? `${mins} min walk` : `${(meters / 1609.34).toFixed(1)} mi away`;
}

interface Candidate {
  venue: RecommendVenue | null;
  place: RecommendPlace | null;
}

function typesOf(c: Candidate): string[] {
  return c.place ? c.place.types : [];
}

function primaryTypeOf(c: Candidate): string | null {
  return c.place?.primaryType ?? null;
}

function vibeMatch(c: Candidate, profile: VibeProfile): number {
  const primary = primaryTypeOf(c);
  if (primary && profile.preferred.includes(primary)) return 3;
  if (typesOf(c).some((t) => profile.preferred.includes(t))) return 2;
  if (c.venue && profile.categories.some((k) => c.venue!.category.toLowerCase().includes(k))) return 3;
  return 0;
}

export function scoreCandidate(
  c: Candidate,
  input: RecommendInput,
  profile: ResolvedVibe,
  radius: number,
): { score: number; reasons: string[]; distance: number } | null {
  const spot = c.venue ?? c.place!;
  const distance = distanceMeters(input, spot);
  if (distance > radius) return null;

  const rating = c.place?.rating ?? null;
  const count = c.place?.ratingCount ?? 0;
  if (rating !== null && count >= 20 && rating < 3.5) return null;

  const walk = (input.walk ?? '').toLowerCase();
  const rawGroup = (input.group ?? '').toLowerCase();
  const group = rawGroup === 'date_night' ? 'date' : rawGroup;
  const types = typesOf(c);
  const primary = primaryTypeOf(c);
  const crowd = c.venue?.crowd ?? null;
  const isOpen = c.place?.isOpen ?? null;

  let score = 0;
  const match = vibeMatch(c, profile);
  score += match;
  if (rating !== null && count > 0) score += (bayesRating(rating, count) - 4.0) * 6;
  else if (!c.venue) score -= 1.5;
  if (rating !== null && count >= 50 && rating < 3.8) score -= 2;
  if (c.venue) score += 0.5;
  if (isOpen === true) score += 1;
  if (isOpen === false) score -= 3;
  if (primary === 'fast_food_restaurant') score -= 1.5;

  const gem = walk === 'far' && rating !== null && rating >= 4.5 && count >= 15 && count <= 400;
  score -= (walk === 'far' ? 0.5 : 2) * (distance / radius);
  if (gem) score += 1.5;

  if (group === 'date') {
    if (c.place?.priceLevel && PRICEY.has(c.place.priceLevel)) score += 0.75;
    if (c.place?.priceLevel === 'PRICE_LEVEL_INEXPENSIVE') score -= 0.5;
    if (crowd && crowd.level >= 4) score -= 1;
  } else if (group === 'group') {
    if (crowd && crowd.level >= 3) score += 0.5;
  } else if (group === 'work') {
    if (types.some((t) => t === 'cafe' || t === 'coffee_shop' || t === 'library')) score += 1;
    if (types.includes('night_club')) score -= 3;
    else if (types.includes('bar')) score -= 1;
    if (crowd && crowd.level >= 3) score -= 1;
  }

  const reasons: string[] = [];
  if (match > 0 && profile.key !== 'explore') reasons.push(profile.key === 'general' ? `Good for ${profile.label}` : `Fits ${profile.label}`);
  if (gem) reasons.push('Highly rated, less known');
  else if (rating !== null && count >= 10) reasons.push(`${rating.toFixed(1)}★ · ${count.toLocaleString('en-US')} reviews`);
  const crowdText = crowdReason(crowd);
  if (crowdText) reasons.push(crowdText);
  else if (isOpen === true) reasons.push('Open now');
  reasons.push(distanceReason(distance));

  return { score: Math.round(score * 100) / 100, reasons: reasons.slice(0, 3), distance };
}

function toItem(c: Candidate, scored: { score: number; reasons: string[]; distance: number }): RecommendItem {
  const v = c.venue;
  const p = c.place;
  const googlePhoto = p?.photoUrls[0] ?? null;
  const photoUrl = v?.imageUrl ?? googlePhoto;
  return {
    id: v ? v.id : `gp:${p!.placeId}`,
    kind: v ? 'venue' : 'place',
    slug: v?.slug ?? null,
    placeId: p?.placeId ?? v?.googlePlaceId ?? null,
    name: v?.name ?? p!.name,
    address: v?.address ?? p!.address,
    lat: v?.lat ?? p!.lat,
    lng: v?.lng ?? p!.lng,
    distanceMeters: Math.round(scored.distance),
    walkMinutes: Math.max(1, Math.round(scored.distance / WALK_METERS_PER_MINUTE)),
    category: v?.category ?? p?.primaryType ?? null,
    rating: p?.rating ?? null,
    ratingCount: p?.ratingCount ?? 0,
    priceLevel: p?.priceLevel ?? null,
    isOpen: p?.isOpen ?? null,
    photoUrl,
    photoAttribution: photoUrl && photoUrl === googlePhoto ? (p?.photoAttributions[0] || null) : null,
    websiteUri: p?.websiteUri ?? null,
    crowd: v?.crowd ?? null,
    reasons: scored.reasons,
    score: scored.score,
  };
}

function isExplorable(p: RecommendPlace): boolean {
  if (!p.primaryType || p.ratingCount < 20) return false;
  return EXPLORE_TYPES.has(p.primaryType) || p.types.some((t) => EXPLORE_TYPES.has(t) && t !== 'tourist_attraction');
}

/**
 * Ranks what is around the guest. `forYou` matches their vibe; `explore` is
 * the best-rated culture, parks and attractions nearby that are not already
 * in `forYou`.
 */
export function rankRecommendations(
  input: RecommendInput,
  pools: Partial<Record<RecommendPool, RecommendPlace[]>>,
  venues: RecommendVenue[],
  limits: { forYou: number; explore: number } = { forYou: 8, explore: 6 },
): { forYou: RecommendItem[]; explore: RecommendItem[]; radiusMeters: number; vibe: string } {
  const profile = vibeProfile(input.vibe, input.hour);
  const radius = radiusForWalk(input.walk);

  const seenPlaces = new Set<string>();
  const vibePlaces: RecommendPlace[] = [];
  for (const pool of profile.pools) {
    for (const p of pools[pool] ?? []) {
      if (!p.placeId || !p.name || seenPlaces.has(p.placeId)) continue;
      seenPlaces.add(p.placeId);
      vibePlaces.push(p);
    }
  }

  const usedPlaceIds = new Set<string>();
  const candidates: Candidate[] = venues.map((venue) => {
    const place = vibePlaces.find((p) => sameSpot(venue, p))
      ?? (pools.explore ?? []).find((p) => sameSpot(venue, p))
      ?? null;
    if (place) usedPlaceIds.add(place.placeId);
    return { venue, place };
  });
  for (const p of vibePlaces) {
    if (!usedPlaceIds.has(p.placeId)) candidates.push({ venue: null, place: p });
  }

  const forYou = candidates
    .map((c) => {
      const s = scoreCandidate(c, input, profile, radius);
      return s && vibeMatch(c, profile) > 0 ? toItem(c, s) : null;
    })
    .filter((x): x is RecommendItem => x !== null)
    .sort((a, b) => b.score - a.score)
    .slice(0, limits.forYou);

  const taken = new Set(forYou.flatMap((i) => [i.id, i.placeId].filter(Boolean) as string[]));
  const exploreProfile: ResolvedVibe = { key: 'explore', pools: ['explore'], preferred: [...RECOMMEND_POOLS.explore], categories: ['park', 'museum', 'gallery'], label: 'exploring' };
  const explore = (pools.explore ?? [])
    .filter((p) => p.placeId && !taken.has(p.placeId) && !usedPlaceIds.has(p.placeId) && isExplorable(p))
    .map((p) => {
      const s = scoreCandidate({ venue: null, place: p }, input, exploreProfile, Math.max(radius, 3000));
      return s ? toItem({ venue: null, place: p }, s) : null;
    })
    .filter((x): x is RecommendItem => x !== null)
    .sort((a, b) => b.score - a.score)
    .slice(0, limits.explore);

  return { forYou, explore, radiusMeters: radius, vibe: profile.key };
}
