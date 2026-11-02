/**
 * The order of the Discover deck. Pure: the client sends the cards it is about
 * to show with the facts it already has (from places.nearbySearch, the venues
 * API, events.nearby and plans.bookables), and the guest's answers and saved
 * preferences, the same way places.recommend takes them.
 *
 * Order:
 *   1. Gatherings lead: finite seats, and they end tonight.
 *   2. Cards with a real action (book, request, add) before reference cards.
 *   3. Preference score: vibe match, rating, open now, distance, crowd.
 *
 * A card matching something the guest avoids, or priced above their ceiling
 * when its price is known, is returned as hidden instead of ranked.
 */
import { z } from 'zod';
import { distanceMeters, radiusForWalk, vibeProfile, bayesRating, type ResolvedVibe } from './recommendations';
import { NO_PREFERENCES, preferenceFit, type AvoidTag, type PreferenceFilter } from './preferenceFit';

export const DISCOVER_RANK_MAX = 150;

export const discoverCandidateInput = z.object({
  id: z.string().min(1).max(200),
  kind: z.enum(['place', 'venue', 'event', 'party', 'offering']),
  /** The Discover rail the card sits on (dining, coffee, nightlife, ...). */
  rail: z.string().max(40).optional(),
  /** Free-text category: a Bytspot venue's category, an event's genre. */
  category: z.string().max(80).optional(),
  types: z.array(z.string().max(60)).max(20).optional(),
  primaryType: z.string().max(60).optional(),
  priceLevel: z.string().max(40).optional(),
  rating: z.number().min(0).max(5).optional(),
  ratingCount: z.number().int().min(0).optional(),
  isOpen: z.boolean().optional(),
  lat: z.number().min(-90).max(90).optional(),
  lng: z.number().min(-180).max(180).optional(),
  crowdLevel: z.number().int().min(0).max(5).optional(),
  /** Bytspot can act on it now: book, request or add to a Plan. */
  actionable: z.boolean().optional(),
}).strict();

export type DiscoverCandidate = z.infer<typeof discoverCandidateInput>;

export interface DiscoverRankInput {
  lat: number; lng: number;
  vibe?: string; walk?: string; group?: string; hour?: number;
  preferences?: PreferenceFilter;
}

export interface DiscoverRankResult {
  /** Kept card ids, best first. */
  order: string[];
  hidden: { id: string; hiddenBy: AvoidTag | 'price' }[];
}

/** Discover rails that answer each vibe. */
const VIBE_RAILS: Record<string, string[]> = {
  drinks: ['nightlife'],
  coffee: ['coffee'],
  work: ['coffee'],
  food: ['dining'],
  events: ['entertainment', 'event', 'nightlife'],
  date: ['dining', 'nightlife'],
  indoor: ['dining', 'coffee', 'entertainment'],
};

function vibeMatch(c: DiscoverCandidate, profile: ResolvedVibe): number {
  if (c.primaryType && profile.preferred.includes(c.primaryType)) return 3;
  if ((c.types ?? []).some((t) => profile.preferred.includes(t))) return 2;
  const category = (c.category ?? '').toLowerCase();
  if (category && profile.categories.some((word) => category.includes(word))) return 2;
  const rails = VIBE_RAILS[profile.key];
  if (rails && c.rail && rails.includes(c.rail.toLowerCase())) return 1.5;
  return 0;
}

export function scoreDiscoverCandidate(
  c: DiscoverCandidate,
  input: DiscoverRankInput,
  profile: ResolvedVibe,
  radius: number,
): { keep: true; score: number } | { keep: false; hiddenBy: AvoidTag | 'price' } {
  const crowd = c.crowdLevel !== undefined ? { level: c.crowdLevel, source: null } : null;
  const fit = preferenceFit(
    { types: c.types, primaryType: c.primaryType, category: c.category, priceLevel: c.priceLevel, crowd },
    input.preferences ?? NO_PREFERENCES,
  );
  if (!fit.keep) return { keep: false, hiddenBy: fit.hiddenBy! };

  const types = c.types ?? [];
  const rawGroup = (input.group ?? '').toLowerCase();
  const group = rawGroup === 'date_night' ? 'date' : rawGroup;
  let score = fit.scoreDelta + vibeMatch(c, profile);

  if (c.rating !== undefined && c.ratingCount !== undefined && c.ratingCount > 0) {
    score += (bayesRating(c.rating, c.ratingCount) - 4.0) * 6;
  } else if (c.rating !== undefined) {
    score += (c.rating - 4.0) * 1.5;
  }
  if (c.kind === 'venue') score += 0.5;
  if (c.isOpen === true) score += 1;
  if (c.isOpen === false) score -= 3;
  if (c.primaryType === 'fast_food_restaurant') score -= 1.5;

  // Unlike Home picks, nothing is dropped for distance: the deck is already
  // local. Farther cards only sink, up to three walk radii out.
  if (c.lat !== undefined && c.lng !== undefined) {
    const distance = distanceMeters(input, { lat: c.lat, lng: c.lng });
    const walk = (input.walk ?? '').toLowerCase();
    score -= (walk === 'far' ? 0.5 : 2) * Math.min(distance / radius, 3);
  }

  if (group === 'date') {
    if (c.priceLevel && c.priceLevel !== 'PRICE_LEVEL_INEXPENSIVE' && c.priceLevel !== 'PRICE_LEVEL_FREE') score += 0.75;
    if (c.priceLevel === 'PRICE_LEVEL_INEXPENSIVE') score -= 0.5;
    if (crowd && crowd.level >= 4) score -= 1;
  } else if (group === 'group') {
    if (crowd && crowd.level >= 3) score += 0.5;
  } else if (group === 'work') {
    if (types.some((t) => t === 'cafe' || t === 'coffee_shop' || t === 'library')) score += 1;
    if (types.includes('night_club')) score -= 3;
    else if (types.includes('bar')) score -= 1;
    if (crowd && crowd.level >= 3) score -= 1;
  }
  return { keep: true, score: Math.round(score * 100) / 100 };
}

export function rankDiscover(input: DiscoverRankInput, candidates: readonly DiscoverCandidate[]): DiscoverRankResult {
  const profile = vibeProfile(input.vibe, input.hour);
  const radius = radiusForWalk(input.walk);
  const seen = new Set<string>();
  const kept: { c: DiscoverCandidate; score: number }[] = [];
  const hidden: DiscoverRankResult['hidden'] = [];
  for (const c of candidates) {
    if (seen.has(c.id)) continue;
    seen.add(c.id);
    const scored = scoreDiscoverCandidate(c, input, profile, radius);
    if (scored.keep) kept.push({ c, score: scored.score });
    else hidden.push({ id: c.id, hiddenBy: scored.hiddenBy });
  }
  kept.sort((a, b) => {
    const party = Number(b.c.kind === 'party') - Number(a.c.kind === 'party');
    if (party) return party;
    const actionable = Number(b.c.actionable === true) - Number(a.c.actionable === true);
    if (actionable) return actionable;
    if (a.score !== b.score) return b.score - a.score;
    return a.c.id < b.c.id ? -1 : a.c.id > b.c.id ? 1 : 0;
  });
  return { order: kept.map((k) => k.c.id), hidden };
}
