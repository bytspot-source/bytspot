/**
 * Saved preferences applied to a candidate place. Pure: the caller passes the
 * place's own facts (Google types and price level, a Bytspot venue's category,
 * its crowd reading) and the guest's preferences.
 *
 * Two hard rules and nothing invented:
 *   * A place matching something the guest avoids is left out.
 *   * A place priced above the guest's ceiling is left out only when its price
 *     is known. An unlisted price is kept and said to be unlisted.
 */
import { z } from 'zod';

export const AVOID_TAGS = ['nightclubs', 'bars', 'live_music', 'sports_bars', 'fast_food', 'busy'] as const;
export type AvoidTag = typeof AVOID_TAGS[number];

/** Google's price levels on a 0–4 scale. Free counts as within any ceiling. */
const PRICE_LEVELS: Record<string, number> = {
  PRICE_LEVEL_FREE: 0,
  PRICE_LEVEL_INEXPENSIVE: 1,
  PRICE_LEVEL_MODERATE: 2,
  PRICE_LEVEL_EXPENSIVE: 3,
  PRICE_LEVEL_VERY_EXPENSIVE: 4,
};

export const preferenceFilterInput = z.object({
  avoid: z.array(z.enum(AVOID_TAGS)).max(AVOID_TAGS.length).optional(),
  /** Highest Google price level to show, 1 ($) to 4 ($$$$). */
  priceCeiling: z.number().int().min(1).max(4).nullable().optional(),
}).strict();

export interface PreferenceFilter {
  avoid: AvoidTag[];
  priceCeiling: number | null;
}

export const NO_PREFERENCES: PreferenceFilter = { avoid: [], priceCeiling: null };

/** Keeps only known tags and a 1–4 ceiling, so stored or sent junk cannot widen or break a filter. */
export function normalizePreferences(raw: { avoid?: readonly string[] | null; priceCeiling?: number | null } | null | undefined): PreferenceFilter {
  const avoid = [...new Set((raw?.avoid ?? []).filter((tag): tag is AvoidTag => (AVOID_TAGS as readonly string[]).includes(tag)))];
  const ceiling = raw?.priceCeiling;
  return { avoid, priceCeiling: Number.isInteger(ceiling) && ceiling! >= 1 && ceiling! <= 4 ? ceiling! : null };
}

/** The stricter of two filters: every avoided tag, and the lower ceiling. */
export function mergePreferences(a: PreferenceFilter, b: PreferenceFilter): PreferenceFilter {
  const ceilings = [a.priceCeiling, b.priceCeiling].filter((c): c is number => c !== null);
  return { avoid: [...new Set([...a.avoid, ...b.avoid])], priceCeiling: ceilings.length ? Math.min(...ceilings) : null };
}

const AVOID_TYPES: Record<Exclude<AvoidTag, 'busy'>, string[]> = {
  nightclubs: ['night_club', 'dance_hall'],
  bars: ['bar', 'pub', 'wine_bar', 'cocktail_bar', 'lounge_bar', 'sports_bar', 'brewpub', 'beer_garden', 'irish_pub', 'bar_and_grill'],
  live_music: ['live_music_venue', 'concert_hall', 'karaoke'],
  sports_bars: ['sports_bar'],
  fast_food: ['fast_food_restaurant'],
};

/** Words in a Bytspot venue's free-text category. */
const AVOID_CATEGORY_WORDS: Record<Exclude<AvoidTag, 'busy'>, string[]> = {
  nightclubs: ['nightclub', 'night club', 'club', 'nightlife'],
  bars: ['bar', 'pub', 'lounge', 'cocktail', 'brewery'],
  live_music: ['live music', 'concert', 'karaoke'],
  sports_bars: ['sports bar'],
  fast_food: ['fast food'],
};

const AVOID_LABELS: Record<AvoidTag, string> = {
  nightclubs: 'night clubs', bars: 'bars', live_music: 'live music venues',
  sports_bars: 'sports bars', fast_food: 'fast food', busy: 'usually busy right now',
};

export function avoidLabel(tag: AvoidTag): string {
  return AVOID_LABELS[tag];
}

export interface FitFacts {
  types?: readonly string[] | null;
  primaryType?: string | null;
  /** A Bytspot venue's category text. */
  category?: string | null;
  priceLevel?: string | null;
  crowd?: { level: number; source: string | null } | null;
}

export interface PreferenceFit {
  keep: boolean;
  /** Why the place was left out; null when kept. */
  hiddenBy: AvoidTag | 'price' | null;
  /** 0–4 when the price is known, null when unlisted. */
  priceLevel: number | null;
  /** A short line for the card when a ceiling is set: within it, or unlisted. */
  priceReason: string | null;
  /** Small ranking nudge: a known price within the ceiling beats an unlisted one. */
  scoreDelta: number;
}

export function priceLevelValue(level: string | null | undefined): number | null {
  return level && level in PRICE_LEVELS ? PRICE_LEVELS[level] : null;
}

export function priceSigns(level: number): string {
  return level === 0 ? 'Free' : '$'.repeat(level);
}

function categoryHas(category: string, word: string): boolean {
  return new RegExp(`(^|[^a-z])${word.replace(/ /g, '[ _-]')}([^a-z]|$)`).test(category);
}

export function matchedAvoidTag(facts: FitFacts, avoid: readonly AvoidTag[]): AvoidTag | null {
  if (!avoid.length) return null;
  const types = new Set([...(facts.types ?? []), ...(facts.primaryType ? [facts.primaryType] : [])]);
  const category = (facts.category ?? '').toLowerCase();
  for (const tag of avoid) {
    if (tag === 'busy') {
      if (facts.crowd && facts.crowd.level >= 3) return tag;
      continue;
    }
    if (AVOID_TYPES[tag].some((type) => types.has(type))) return tag;
    if (category && AVOID_CATEGORY_WORDS[tag].some((word) => categoryHas(category, word))) return tag;
  }
  return null;
}

export function preferenceFit(facts: FitFacts, prefs: PreferenceFilter): PreferenceFit {
  const priceLevel = priceLevelValue(facts.priceLevel);
  const avoided = matchedAvoidTag(facts, prefs.avoid);
  if (avoided) return { keep: false, hiddenBy: avoided, priceLevel, priceReason: null, scoreDelta: 0 };
  if (prefs.priceCeiling === null) return { keep: true, hiddenBy: null, priceLevel, priceReason: null, scoreDelta: 0 };
  if (priceLevel === null) return { keep: true, hiddenBy: null, priceLevel, priceReason: 'Price not listed', scoreDelta: 0 };
  if (priceLevel > prefs.priceCeiling) return { keep: false, hiddenBy: 'price', priceLevel, priceReason: null, scoreDelta: 0 };
  return { keep: true, hiddenBy: null, priceLevel, priceReason: `${priceSigns(priceLevel)} · within your price`, scoreDelta: 0.5 };
}
