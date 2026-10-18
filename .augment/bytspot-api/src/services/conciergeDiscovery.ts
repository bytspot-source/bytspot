import { z } from 'zod';
import { isIP } from 'node:net';
import { config } from '../config';
import { MENU_REVIEW_MS, type MenuEvidenceResult } from './menuEvidence';
import { distanceMeters, radiusForWalk, sameSpot, type RecommendPlace, type RecommendVenue } from './recommendations';
import { DISCOVERY_RAILS, discoveryRail } from './discoveryTaxonomy';

export const coordinateSchema = z.object({
  lat: z.number().finite().min(-90).max(90),
  lng: z.number().finite().min(-180).max(180),
}).strict();
export const conciergeDiscoverInput = z.object({
  messages: z.array(z.object({
    role: z.enum(['user', 'assistant']), content: z.string().max(2000).trim().min(1),
  }).strict()).min(1).max(10).refine((messages) => messages.some((m) => m.role === 'user'), 'A user message is required'),
  location: coordinateSchema.optional(),
  quizAnswers: z.object({
    vibe: z.string().trim().max(40).optional(), walk: z.string().trim().max(40).optional(),
    group: z.string().trim().max(40).optional(),
  }).strict().optional(),
}).strict();

/** A provider website is a handoff, never proof of a menu or a supported transaction. */
export function conciergeWebsiteURL(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length > 2048 || /[\s\\\p{C}]/u.test(raw)) return null;
  try {
    const url = new URL(raw);
    const host = url.hostname.toLowerCase();
    if (url.protocol !== 'https:' || url.username || url.password || !host.includes('.') || isIP(host.replace(/^\[|\]$/g, ''))
      || /(^|\.)(localhost|local|internal|test|invalid)$/.test(host) || url.port) return null;
    return url.href;
  } catch { return null; }
}

export const conciergeMenuEvidenceSchema = z.object({
  dishId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/), revision: z.string().regex(/^[1-9][0-9]{0,15}$/),
  dishName: z.string().min(1).max(120), source: z.literal('vendor_menu'),
  mediaId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/), sourceUrl: z.string(),
  reviewedAt: z.string().datetime(), expiresAt: z.string().datetime(), retrievedAt: z.string().datetime(),
}).strict().refine((e) => {
  const reviewed = Date.parse(e.reviewedAt), expires = Date.parse(e.expiresAt), retrieved = Date.parse(e.retrievedAt);
  return reviewed <= retrieved && retrieved < expires && expires - reviewed <= MENU_REVIEW_MS
    && e.sourceUrl === `${config.publicApiUrl.replace(/\/$/, '')}/media/menu-evidence/${e.dishId}/${e.revision}`;
}, 'Evidence must reference the reviewed source revision');

export const conciergeCardSchema = z.object({
  id: z.string().min(1), kind: z.enum(['venue', 'place']), placeId: z.string().nullable(),
  name: z.string().min(1), address: z.string(), lat: coordinateSchema.shape.lat, lng: coordinateSchema.shape.lng,
  category: z.string(), rating: z.number().min(0).max(5).nullable(), isOpen: z.boolean().nullable(),
  photoUrl: z.string().nullable(), crowd: z.null(), reasons: z.array(z.string()).max(3),
  capability: z.literal('details'), source: z.enum(['bytspot', 'google', 'google-stale']),
  rail: z.enum(DISCOVERY_RAILS),
  websiteUrl: z.string().refine((url) => conciergeWebsiteURL(url) !== null).nullable().default(null),
  menuEvidence: z.array(conciergeMenuEvidenceSchema).max(3).default([]),
}).strict();
export const conciergeDiscoverOutput = z.object({
  version: z.literal(1), reply: z.string(), status: z.enum(['ready', 'needs_location', 'unavailable', 'empty']),
  cards: z.array(conciergeCardSchema).max(3), refinements: z.array(z.string()).max(4),
}).strict();
export type ConciergeInput = z.infer<typeof conciergeDiscoverInput>;
export type ConciergeResponse = z.infer<typeof conciergeDiscoverOutput>;
export type ConciergeCard = z.infer<typeof conciergeCardSchema>;
export type Coordinate = z.infer<typeof coordinateSchema>;

/** Search plans are untrusted. Coordinates and radius are always server-owned;
 * no model reply/ID/evidence/action fields cross this boundary. */
export const conciergeSearchSchema = z.object({
  query: z.string().trim().min(1).max(120).regex(/^[\p{L}\p{N} &'’.-]+$/u),
  rail: z.enum(DISCOVERY_RAILS),
  mode: z.enum(['category', 'name']),
  location: coordinateSchema,
  radius: z.number().int().min(400).max(5000),
}).strict();
export type ConciergeSearch = z.infer<typeof conciergeSearchSchema>;
export type PlacesOutcome = { places: RecommendPlace[]; source: 'google' | 'google-stale' | 'none' | 'unavailable' };
export const conciergePlanSchema = conciergeSearchSchema.pick({ query: true, rail: true, mode: true }).extend({
  needsLocation: z.boolean(), budget: z.boolean(), menu: z.boolean(), openNow: z.boolean(), firstStop: z.boolean(),
}).strict();
export type ConciergePlan = z.infer<typeof conciergePlanSchema>;
export type ConciergePlanContext = {
  messages: string[];
  fallback: ConciergePlan;
  locationConfirmed: boolean;
};
export const CONCIERGE_PLAN_TIMEOUT_MS = 1200;
export interface ConciergeDependencies {
  venues(search: ConciergeSearch): Promise<RecommendVenue[]>;
  places(search: ConciergeSearch): Promise<PlacesOutcome>;
  reconcile?(places: RecommendPlace[]): Promise<{ venues: RecommendVenue[]; hiddenPlaceIds: string[] }>;
  plan?(context: ConciergePlanContext, options: { signal: AbortSignal }): Promise<unknown>;
  menuEvidence?(search: ConciergeSearch): Promise<MenuEvidenceResult[]>;
}

type Intent = Pick<ConciergeSearch, 'query' | 'rail' | 'mode'>;
const CATEGORIES: Array<[RegExp, string]> = [
  [/\b(?:coffee(?: shops?)?|caf[eé]s?|work)\b/i, 'coffee'],
  [/\b(?:pizza|pizzerias?)\b/i, 'pizza'], [/\b(?:sushi)\b/i, 'sushi'],
  [/\b(?:restaurants?|dining|dinner|lunch|food|date(?: night)?)\b/i, 'restaurant'],
  [/\b(?:baker(?:y|ies)|pastries)\b/i, 'bakery'],
  [/\b(?:bars?|drinks?|cocktails?|pubs?)\b/i, 'bar'],
  [/\b(?:nightlife|nightclubs?|clubs?)\b/i, 'night_club'],
  [/\b(?:museums?|culture)\b/i, 'museum'], [/\b(?:parks?|outdoors?)\b/i, 'park'],
  [/\b(?:shops?|shopping|retail)\b/i, 'shopping'],
  [/\b(?:experiences?|attractions?|explore)\b/i, 'attraction'],
  [/\b(?:social|community|meetups?)\b/i, 'community'],
  [/\b(?:events?|music|entertainment)\b/i, 'event'],
  [/\b(?:wellness|spas?|fitness|gyms?)\b/i, 'spa'],
  [/\b(?:classes|class|workshops?|education|learn|create)\b/i, 'education'],
  [/\b(?:hotels?|stays?|lodging)\b/i, 'hotel'],
  [/\b(?:parking|move|transport|mobility)\b/i, 'parking'],
  [/\b(?:celebrate|celebrations?|part(?:y|ies)|weddings?|birthdays?)\b/i, 'wedding'],
  [/\b(?:services?|laundry)\b/i, 'service'],
];
const QUERIES: Record<string, string> = {
  night_club: 'night club', shopping: 'shops', attraction: 'tourist attractions',
  community: 'community center', event: 'event venue', education: 'classes',
  wedding: 'event venue', service: 'laundry',
};
function categoryIntent(category: string): Intent {
  return { query: QUERIES[category] ?? category, rail: discoveryRail(category === 'pizza' || category === 'sushi' ? 'restaurant' : category === 'bakery' ? 'cafe' : category), mode: 'category' };
}

const LOCALITY = /\b(?:in|near|around|at|within|downtown|midtown|uptown|city|town|visiting|traveling|travelling)\b/i;
// Common bare cities are protected without mistaking every unknown dish for a city.
// Other named localities are handled by explicit prepositions or the planner.
const BARE_CITY = /\b(?:Boston|Paris|Tokyo|London|Brooklyn|Manhattan|Seattle|Chicago|Miami|Austin|Berlin|Rome|Sydney|Toronto|New York|San Francisco|Los Angeles)\b/i;
const BUDGET = /\b(?:cheap(?:er)?|budget|affordable|price|prices|cost|under|dollars?)\b|\$/i;
const MENU = /\b(?:menus?|dish|dishes|vegan|vegetarian|gluten|allergies|allergy|halal|kosher)\b/i;
const UNSAFE = /https?:|[<>/{}]|\b(?:ignore (?:rules|instructions|previous)|fabricate|system prompt|tool calls?|api key)\b/i;
const CONFIRM_LOCATION = /^(?:use |search |yes,? )?(?:my |the )?current location[.!]?$/i;
const REFINEMENT = /^(?:(?:please|and|also|but|only|with|make it|something|a little|what about|how about|can you make it)\s+)*(?:closer|nearest|closest|cheaper|cheap|budget|affordable|under\b.*|\$.*|vegan(?: menu| options)?|vegetarian(?: menu| options)?|gluten.free|halal|kosher|menu|menus|open (?:right )?now|quiet(?:er)?|not\b.*|no\b.*|without\b.*|avoid\b.*|yes|ok(?:ay)?|sure)[.!?]?$/i;
function nearbyText(text: string): string {
  return text.replace(/\b(?:near me|around me|nearby|around here|at my current location|in my area|within walking distance)\b/gi, ' ').trim();
}
function words(text: string): string[] { return text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []; }
function excludedWords(target: string): string[] {
  return words(target).flatMap((word) => /^(?:coffee|caf[eé]s?)$/.test(word) ? ['coffee', 'cafe', 'café', 'cafes'] : [word]);
}
function compact(text: string): string { return text.replace(/\s+/g, ' ').trim().replace(/[.!?]+$/, '').trim(); }
type LocalPlan = Omit<ConciergePlan, 'query' | 'rail' | 'mode'> & {
  search: ConciergeSearch; blocked: boolean; exclusions: string[]; messages: string[]; locationConfirmed: boolean;
};

/** Useful no-key fallback. Unknown text stays search text, never implicit GPS
 * consent. New standalone requests replace prior intent; refinements retain it. */
export function planConcierge(input: ConciergeInput): LocalPlan {
  const preferred = CATEGORIES.find(([pattern]) => pattern.test(input.quizAnswers?.vibe ?? ''));
  const defaultIntent = categoryIntent(preferred?.[1] ?? 'restaurant');
  let intent = defaultIntent;
  let radius = radiusForWalk(input.quizAnswers?.walk);
  if (!Number.isFinite(radius) || radius < 400 || radius > 5000) radius = 2000;
  const defaultRadius = radius;
  let needsLocation = false, budget = false, menu = false, openNow = false, firstStop = false, blocked = false;
  let locationConfirmed = false;
  let exclusions: string[] = [], messages: string[] = [];
  for (const message of input.messages.filter((m) => m.role === 'user')) {
    let text = message.content.trim();
    if (CONFIRM_LOCATION.test(text)) {
      needsLocation = false;
      locationConfirmed = true;
      // Retain the intended search, not an old city's words, after explicit consent.
      messages = [intent.query];
      continue;
    }
    const explicitNewRequest = /\b(?:near me|nearby|around me)\b|^(?:find|search|help plan|show me|i want|we want)\b|["“]/i.test(text)
      || CATEGORIES.some(([pattern]) => pattern.test(text));
    // An acknowledgement or an unclear follow-up is not location consent.
    const descriptiveRefinement = messages.length > 0 && /^(?:with\b|make it\b|somewhere\b|a place with\b)/i.test(text);
    const refinement = REFINEMENT.test(text) || descriptiveRefinement || (needsLocation && !explicitNewRequest);
    if (!refinement) {
      intent = defaultIntent;
      radius = defaultRadius;
      needsLocation = budget = menu = openNow = firstStop = blocked = locationConfirmed = false;
      exclusions = [];
      messages = [];
    }
    messages.push(text);
    if (/^(?:yes|ok(?:ay)?|sure)[.!?]?$/i.test(text)) continue;
    if (/\b(?:closer|nearest|closest)\b/i.test(text)) radius = Math.max(400, Math.min(800, Math.floor(radius / 2)));
    if (/\bwithin walking distance\b/i.test(text)) radius = Math.min(radius, 1500);
    budget ||= BUDGET.test(text);
    menu ||= MENU.test(text);
    openNow ||= /\bopen(?: right)? now\b/i.test(text);
    firstStop ||= /\b(?:plan|itinerary|multi.stop|first stop)\b/i.test(text);
    text = nearbyText(text);
    const named = text.match(/^(?:find\s+|search for\s+)?["“]([^"”]{1,120})["”][.!?]?$/i)
      ?? text.match(/^(?:find (?:a place )?)?(?:named|called)\s+([\p{L}\p{N} &'’.-]{1,120})$/iu);
    const nameQuery = conciergeSearchSchema.shape.query.safeParse(named?.[1]);
    if (named && nameQuery.success && !LOCALITY.test(named[1])
      && BARE_CITY.exec(named[1])?.[0].toLowerCase() !== named[1].trim().toLowerCase()) {
      intent = { query: nameQuery.data, rail: 'explore', mode: 'name' };
      continue;
    }
    if (/["“”]/.test(text) || /^(?:find )?(?:named|called)\b/i.test(text)) {
      needsLocation = true; // Preserve the existing invalid-name clarification contract.
      blocked = true; // Location consent alone cannot repair an invalid name.
      continue;
    }
    if (UNSAFE.test(text)) { blocked = true; continue; }
    const locality = text.search(LOCALITY);
    if (locality >= 0 || BARE_CITY.test(text)) {
      needsLocation = true;
      locationConfirmed = false;
      // Remove the location phrase, not trailing dietary/budget refinements.
      // This query is only eligible after explicit supplied-location consent.
      text = text.replace(/\b(?:in|near|around|at|within|visiting|traveling|travelling)\s+.*?(?=\b(?:with|without|but|and|under|open|vegan|vegetarian|gluten|quiet|cheap|not|no)\b|$)/gi, ' ')
        .replace(/\b(?:downtown|midtown|uptown|city|town)\b/gi, ' ').replace(BARE_CITY, ' ');
    }
    // Negative targets never become positive searches. Ambiguous negative-only
    // requests clarify rather than silently using the default restaurant/coffee.
    text = text.replace(/\b(?:do not|don't|don’t)\s+(?:want|like|include)\s+/gi, 'not ')
      .replace(/\banything but\s+/gi, 'not ');
    text = text.replace(/\b(?:not|no|without|avoid|rather than)\s+([^,;.!?]+?)(?=\s+(?:but|instead|and)\b|[,;.!?]|$)/gi, (_, target: string) => {
      exclusions.push(compact(target.toLowerCase()));
      return ' ';
    });
    const category = descriptiveRefinement ? undefined : CATEGORIES.find(([pattern]) => pattern.test(text));
    const residual = compact(text.toLowerCase().replace(/^(?:make it|somewhere|a place with)\b/i, ' ')
      .replace(/\bunder\s+\$?\s*\d+(?:\.\d+)?|\$\s*\d+(?:\.\d+)?|\b\d+\s*dollars?\b/g, ' ')
      .replace(/\b(?:please|find|search|show|help|plan|itinerary|me|us|a|an|the|some|good|best|great|nice|want|i|we|would|like|looking|for|can|you|recommend|suggest|something|places?|spots?|options?|any|more|else|instead|and|or|but|that|is|are|with|to|go|tonight|today|now|right|open|cheaper|cheap|budget|affordable|closer|closest|nearest|price|prices|cost|under|menu|menus)\b/g, ' ')
      .replace(/[,.!?]/g, ' '));
    if (category) {
      const base = categoryIntent(category[1]);
      const extra = compact(residual.replace(category[0], ' '));
      intent = { ...base, query: compact(`${extra} ${base.query}`) };
    } else if (residual) {
      intent = { query: compact(refinement ? `${intent.query} ${residual}` : residual), rail: refinement ? intent.rail : 'explore', mode: 'category' };
      menu = true; // An unknown dish/search cannot establish menu availability.
    } else if (exclusions.length && (!refinement || messages.length === 1)) {
      blocked = true;
    }
    if (exclusions.some((target) => excludedWords(target).some((word) => words(intent.query).includes(word)))) blocked = true;
    if (!conciergeSearchSchema.shape.query.safeParse(intent.query).success) blocked = true;
    // Any food-specific search beyond broad coffee/restaurants needs a menu caveat.
    menu ||= intent.rail === 'eat_drink' && !['coffee', 'restaurant'].includes(intent.query);
  }
  return {
    search: conciergeSearchSchema.parse({ ...intent, query: conciergeSearchSchema.shape.query.safeParse(intent.query).success ? intent.query : 'restaurant', location: input.location, radius }),
    needsLocation, budget, menu, openNow, firstStop, blocked, exclusions, messages, locationConfirmed,
  };
}

async function boundedPlan(input: ConciergeInput, dependencies: ConciergeDependencies): Promise<LocalPlan> {
  const fallback = planConcierge(input);
  if (!dependencies.plan || fallback.needsLocation || fallback.blocked) return fallback;
  const controller = new AbortController();
  const base = conciergePlanSchema.parse({
    query: fallback.search.query, rail: fallback.search.rail, mode: fallback.search.mode,
    needsLocation: fallback.needsLocation, budget: fallback.budget, menu: fallback.menu,
    openNow: fallback.openNow, firstStop: fallback.firstStop,
  });
  try {
    const raw = await withDeadline(Promise.resolve().then(() => dependencies.plan!({
      messages: [...fallback.messages], fallback: { ...base }, locationConfirmed: fallback.locationConfirmed,
    }, { signal: controller.signal })), CONCIERGE_PLAN_TIMEOUT_MS);
    const parsed = conciergePlanSchema.safeParse(raw);
    if (!parsed.success) return fallback;
    const proposed = parsed.data;
    // No invented geographic terms or unrelated query terms, even from a valid
    // JSON plan. Keep every fallback constraint; rejection uses the full fallback.
    const original = words(base.query), next = words(proposed.query);
    if (UNSAFE.test(proposed.query) || (base.mode !== 'name' && (LOCALITY.test(proposed.query) || BARE_CITY.test(proposed.query)))
      || original.some((word) => !next.includes(word))
      || next.some((word) => !original.includes(word) && !['restaurant', 'restaurants', 'places'].includes(word))
      || proposed.mode !== base.mode || (base.mode === 'name' && proposed.query !== base.query)
      || fallback.exclusions.some((target) => excludedWords(target).some((word) => next.includes(word)))) return fallback;
    return {
      ...fallback,
      search: conciergeSearchSchema.parse({ ...fallback.search, query: proposed.query, rail: proposed.rail, mode: proposed.mode }),
      needsLocation: !fallback.locationConfirmed && proposed.needsLocation,
      budget: fallback.budget || proposed.budget, menu: fallback.menu || proposed.menu,
      openNow: fallback.openNow || proposed.openNow, firstStop: fallback.firstStop || proposed.firstStop,
    };
  } catch { return fallback; }
  finally { controller.abort(); }
}

export function withinSearch(location: Coordinate, candidate: Coordinate, radius: number): boolean {
  return coordinateSchema.safeParse(candidate).success && Number.isFinite(distanceMeters(location, candidate))
    && distanceMeters(location, candidate) <= radius;
}
export function googleIdentity(id: string | null): string | null {
  const bare = typeof id === 'string' ? id.replace(/^places\//, '') : '';
  return /^[A-Za-z0-9_-]{1,255}$/.test(bare) ? bare : null;
}

/** A deadline bounds response latency; adapters also impose transport timeouts.
 * Prisma reads are not cancellable here and may finish after this deadline. */
export async function withDeadline<T>(work: Promise<T>, milliseconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Discovery deadline exceeded')), milliseconds);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}

function result(status: ConciergeResponse['status'], reply: string, cards: ConciergeCard[] = [], refinements: string[] = []): ConciergeResponse {
  return conciergeDiscoverOutput.parse({ version: 1, status, reply, cards, refinements });
}

export function createConciergeDiscovery(dependencies: ConciergeDependencies) {
  return async (raw: ConciergeInput): Promise<ConciergeResponse> => {
    const input = conciergeDiscoverInput.parse(raw);
    if (!input.location) return result('needs_location', 'Share or choose a location to find real places nearby.');
    const plan = await boundedPlan(input, dependencies);
    if (plan.needsLocation) return result('needs_location',
      'I cannot safely resolve that location or place name. Choose a location and confirm “use my current location”, or give a place name in quotes to search near your supplied location.',
      [], ['Use my current location']);
    if (plan.blocked) return result('empty',
      'I cannot safely search that request without losing its constraints. Please name a place or type of place you do want nearby.',
      [], ['Restaurants nearby', 'Coffee nearby']);
    const { search } = plan;
    const matchesExclusions = (name: string, category: string) => plan.exclusions.some((target) => {
      const terms = words(`${name} ${category.replace(/_/g, ' ')}`);
      return excludedWords(target).some((term) => terms.includes(term));
    });
    // At most one bounded planner call, then one bounded Google search. Failures are kept
    // separate from successful empty searches; neither source can invent cards.
    const checksMenus = Boolean(dependencies.menuEvidence && search.mode === 'category'
      && ['eat_drink', 'explore'].includes(search.rail));
    const [venueResult, placeResult, menuResult] = await Promise.allSettled([
      withDeadline(Promise.resolve().then(() => dependencies.venues(search)), 3000),
      withDeadline(Promise.resolve().then(() => dependencies.places(search)), 9000),
      checksMenus ? withDeadline(Promise.resolve().then(() => dependencies.menuEvidence!(search)), 3000) : Promise.resolve([]),
    ]);
    const menuFailed = menuResult.status === 'rejected';
    const menuRows = (menuResult.status === 'fulfilled' ? menuResult.value : []).filter((row) => {
      const parsed = conciergeMenuEvidenceSchema.safeParse(row.evidence);
      return parsed.success && discoveryRail(row.venue.category) === 'eat_drink'
        && Date.parse(parsed.data.retrievedAt) <= Date.now() && Date.now() < Date.parse(parsed.data.expiresAt);
    });
    const provider = placeResult.status === 'fulfilled' ? placeResult.value : { places: [], source: 'unavailable' as const };
    let failed = venueResult.status === 'rejected' || provider.source === 'none' || provider.source === 'unavailable';
    const stale = provider.source === 'google-stale';
    let reconciled: RecommendVenue[] = [];
    let hidden = new Set<string>();
    let safePlaces = provider.places;
    if (dependencies.reconcile && safePlaces.length) {
      try {
        const resolved = await withDeadline(dependencies.reconcile(safePlaces), 3000);
        reconciled = resolved.venues;
        hidden = new Set(resolved.hiddenPlaceIds.map(googleIdentity).filter((id): id is string => id !== null));
      } catch {
        // Without catalog reconciliation, a hidden place could reappear as external.
        safePlaces = [];
        failed = true;
      }
    }
    const venues = [...(venueResult.status === 'fulfilled' ? venueResult.value : []), ...reconciled, ...menuRows.map((row) => row.venue)]
      .filter((v) => !hidden.has(googleIdentity(v.googlePlaceId) ?? ''))
      .filter((v) => typeof v.id === 'string' && /^[A-Za-z0-9_-]{1,255}$/.test(v.id) && typeof v.name === 'string' && v.name.trim()
        && !matchesExclusions(v.name, v.category ?? '') && withinSearch(search.location, { lat: v.lat, lng: v.lng }, search.radius))
      .map((v) => ({ ...v, googlePlaceId: googleIdentity(v.googlePlaceId) }))
      .sort((a, b) => distanceMeters(search.location, a) - distanceMeters(search.location, b) || a.id.localeCompare(b.id));
    const places = (provider.source === 'google' || stale ? safePlaces : [])
      .filter((p) => !hidden.has(googleIdentity(p.placeId) ?? ''))
      .filter((p) => googleIdentity(p.placeId) && typeof p.name === 'string' && p.name.trim()
        && !matchesExclusions(p.name, p.primaryType ?? '') && withinSearch(search.location, { lat: p.lat, lng: p.lng }, search.radius))
      .map((p) => ({ ...p, placeId: googleIdentity(p.placeId)! }))
      .sort((a, b) => distanceMeters(search.location, a) - distanceMeters(search.location, b) || a.placeId.localeCompare(b.placeId));
    const cards: ConciergeCard[] = [];
    const seenIds = new Set<string>();
    const seenPlaces = new Set<string>();
    function append(v: RecommendVenue | null, p: RecommendPlace | null) {
      const spot = v ?? p!;
      if (plan.openNow && (stale || p?.isOpen !== true)) return;
      const id = v ? v.id : `gp:${p!.placeId}`;
      const placeId = p?.placeId ?? v?.googlePlaceId ?? null;
      if (seenIds.has(id) || (placeId && seenPlaces.has(placeId))) return;
      seenIds.add(id);
      if (placeId) seenPlaces.add(placeId);
      const category = v?.category ?? p?.primaryType ?? 'place';
      const actualRail = discoveryRail(category);
      // A known unrelated category must not displace a match just because it is closer.
      // Celebrate can legitimately search an event venue, without granting event inventory.
      if (search.mode !== 'name' && search.rail !== 'explore' && actualRail !== 'explore'
        && actualRail !== search.rail && !(search.rail === 'celebrate' && actualRail === 'events')) return;
      const rating = p?.rating != null && Number.isFinite(p.rating) && p.rating >= 0 && p.rating <= 5 ? p.rating : null;
      // Evidence can attach only through the exact canonical venue ID; name/distance
      // reconciliation alone cannot transfer a reviewed dish to a different place.
      const evidenceByDish = new Map(menuRows.filter((row) => row.venue.id === v?.id).map((row) => [row.evidence.dishId, row.evidence]));
      const menuEvidence = actualRail === 'eat_drink' ? [...evidenceByDish.values()].slice(0, 3) : [];
      const reasons = [`${Math.round(distanceMeters(search.location, spot))} m away (straight-line)`];
      if (stale && p) reasons.push('Cached place information; opening status unverified');
      else if (p?.isOpen === true) reasons.push('Open now according to Google');
      if (rating !== null) reasons.push(`${rating.toFixed(1)} stars on Google${stale ? ' (cached)' : ''}`);
      cards.push({ id, kind: v ? 'venue' : 'place', placeId, name: spot.name, address: typeof spot.address === 'string' ? spot.address : '',
        lat: spot.lat, lng: spot.lng, category, rating, isOpen: stale || typeof p?.isOpen !== 'boolean' ? null : p.isOpen,
        photoUrl: null, crowd: null, reasons, capability: 'details',
        source: v ? 'bytspot' : stale ? 'google-stale' : 'google', rail: actualRail,
        menuEvidence, websiteUrl: stale ? null : conciergeWebsiteURL(p?.websiteUri) });
    }
    // Bytspot always owns a shared identity, including name+75m matches used by Discover.
    for (const venue of venues) append(venue, places.find((p) => sameSpot(venue, p)) ?? null);
    for (const place of places) {
      if (!venues.some((v) => sameSpot(v, place))) append(null, place);
    }
    const selected = cards.sort((a, b) => Number(b.menuEvidence.length > 0) - Number(a.menuEvidence.length > 0)
      || distanceMeters(search.location, a) - distanceMeters(search.location, b) || a.id.localeCompare(b.id)).slice(0, 3);
    const caveats = [
      failed ? 'Some discovery sources are unavailable; these results may be incomplete.' : '',
      stale ? 'Google information is cached; opening status is unverified.' : '',
      plan.budget ? 'I cannot verify prices or promise these are cheaper.' : '',
      menuFailed ? 'Reviewed-menu lookup is unavailable; place discovery still works, but dish matches are unconfirmed.' : '',
      selected.some((card) => card.menuEvidence.length)
        ? 'Reviewed menu entries are labeled and linked to their source. A menu listing does not guarantee current availability, dish quality or dietary safety.'
        : plan.menu || selected.some((card) => card.rail === 'eat_drink')
          ? 'No reviewed menu match was confirmed. These are places to investigate, not confirmed dish matches. Dish quality and dietary suitability are not verified.' : '',
      plan.openNow ? 'Only listings Google reports open now are included; hours can change.' : '',
      plan.exclusions.length ? 'Excluded terms were checked against listing names and categories only; other suitability is not verified.' : '',
      plan.firstStop ? 'This searches a first stop for tonight; I cannot build a multi-stop plan or make bookings yet.' : '',
      'Search terms guide discovery, but listing matches do not verify every requested preference.',
    ].filter(Boolean).join(' ');
    if (!selected.length) return result(failed || stale || menuFailed ? 'unavailable' : 'empty',
      `${failed || stale || menuFailed ? 'I could not verify matching places nearby. Please try again.' : `No matching places were found within ${search.radius} m of your supplied location.`} ${caveats}`,
      [], ['Coffee nearby', 'Restaurants nearby']);
    return result('ready', `Here are nearby place listings within ${search.radius} m of your supplied location. Details only; availability is not guaranteed. ${caveats}`,
      selected, ['Closer', 'Coffee nearby', 'Restaurants nearby']);
  };
}
