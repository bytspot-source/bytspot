import { z } from 'zod';
import { isIP } from 'node:net';
import { config } from '../config';
import { MENU_REVIEW_MS, type MenuEvidenceResult } from './menuEvidence';
import { distanceMeters, radiusForWalk, sameSpot, type RecommendPlace, type RecommendVenue } from './recommendations';
import { DISCOVERY_RAILS, discoveryRail } from './discoveryTaxonomy';
import { tableBookingUrlError, type TableBookingLink } from './tableBookingLinks';

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

/** Phase 6: the closed set of actions Concierge may offer. Each runs on the guest's
 * device only after the guest approves it; none is a booking, order or payment.
 * Phase 7: add_to_plan adds a details-only reference to a Plan the guest chooses. */
export const CONCIERGE_ACTIONS = ['directions', 'website', 'book_table', 'add_to_plan', 'save'] as const;
export type ConciergeActionType = typeof CONCIERGE_ACTIONS[number];
export const conciergeActionSchema = z.union([
  z.object({ type: z.enum(['directions', 'website', 'add_to_plan', 'save']) }).strict(),
  z.object({
    type: z.literal('book_table'), provider: z.enum(['opentable', 'resy']), label: z.enum(['OpenTable', 'Resy']), url: z.string(),
  }).strict().refine((a) => tableBookingUrlError(a.provider, a.url) === null
    && (a.provider === 'opentable') === (a.label === 'OpenTable'), 'Only a hand-checked OpenTable or Resy link'),
]);
export type ConciergeAction = z.infer<typeof conciergeActionSchema>;

export const conciergeCardSchema = z.object({
  id: z.string().min(1), kind: z.enum(['venue', 'place']), placeId: z.string().nullable(),
  name: z.string().min(1), address: z.string(), lat: coordinateSchema.shape.lat, lng: coordinateSchema.shape.lng,
  category: z.string(), rating: z.number().min(0).max(5).nullable(), isOpen: z.boolean().nullable(),
  photoUrl: z.string().nullable(), crowd: z.null(), reasons: z.array(z.string()).max(3),
  capability: z.literal('details'), source: z.enum(['bytspot', 'google', 'google-stale']),
  rail: z.enum(DISCOVERY_RAILS),
  websiteUrl: z.string().refine((url) => conciergeWebsiteURL(url) !== null).nullable().default(null),
  menuEvidence: z.array(conciergeMenuEvidenceSchema).max(3).default([]),
  actions: z.array(conciergeActionSchema).max(CONCIERGE_ACTIONS.length).default([]),
}).strict();
export const conciergeProposalSchema = z.object({ type: z.enum(CONCIERGE_ACTIONS), cardId: z.string().min(1) }).strict();
export const conciergeDiscoverOutput = z.object({
  version: z.literal(1), reply: z.string(), status: z.enum(['ready', 'needs_location', 'unavailable', 'empty']),
  cards: z.array(conciergeCardSchema).max(3), refinements: z.array(z.string()).max(4),
  proposal: conciergeProposalSchema.nullable().default(null),
}).strict().superRefine((response, ctx) => {
  for (const card of response.cards) {
    const types = card.actions.map((a) => a.type);
    if (new Set(types).size !== types.length || (types.includes('website') && !card.websiteUrl)
      || (types.includes('book_table') && !card.placeId)) ctx.addIssue({ code: 'custom', message: 'Unsupported card action' });
  }
  const { proposal } = response;
  if (proposal && (response.status !== 'ready' || !response.cards.some((card) => card.id === proposal.cardId
    && card.actions.some((a) => a.type === proposal.type)))) ctx.addIssue({ code: 'custom', message: 'A proposal needs a shown card action' });
});
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
  tableBookings?(placeIds: string[]): Promise<Map<string, TableBookingLink>>;
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

/** A request to act on a shown place. Unsupported acts are named so the reply can decline them. */
export type ConciergeActionRequest = { type: ConciergeActionType | 'unsupported' | 'ride'; target: number | 'last' | 'it' | { name: string } };
const PLAN_ADD = /^(?:please\s+|can you\s+|could you\s+)?(?:add|put)\s+(?:the\s+)?(.{2,120}?)\s+(?:to|on|in|into)\s+(?:my|a|the|our|this)\s+plans?[.!?]*$/iu;
const ACTION_VERBS: Array<[RegExp, ConciergeActionRequest['type']]> = [
  [PLAN_ADD, 'add_to_plan'],
  [/\b(?:uber|lyft|rides?|taxi|cab)\b/i, 'ride'],
  [/\b(?:order|buy|pay|purchase|call|phone|text|message|email|tickets?|deliver(?:y)?|check (?:me |us )?in)\b/i, 'unsupported'],
  [/\b(?:book|reserve)\b.*\b(?:table|reservation|it|that|this|there|them|one)\b|\breservation\b/i, 'book_table'],
  [/\b(?:directions?|navigate|navigation|route me|take me (?:to|there)|get me there|how (?:do i|can i|to) get)\b/i, 'directions'],
  [/\b(?:website|web site|homepage)\b/i, 'website'],
  [/^(?:please\s+|can you\s+|could you\s+)?(?:save|bookmark|favou?rite|remember)\b/i, 'save'],
];
const ORDINALS: Record<string, number> = { first: 1, '1st': 1, '1': 1, second: 2, '2nd': 2, '2': 2, third: 3, '3rd': 3, '3': 3 };

export function conciergeActionRequest(raw: string): ConciergeActionRequest | null {
  const text = raw.trim();
  if (text.length > 200 || /^(?:find|search)\b|\b(?:near me|nearby|around me)\b/i.test(text)) return null;
  const type = ACTION_VERBS.find(([pattern]) => pattern.test(text))?.[1];
  if (!type) return null;
  const ordinal = text.match(/\b(first|second|third|1st|2nd|3rd)\b|(?:#|\bnumber\s*|\boption\s*)([1-3])\b/i);
  if (ordinal) return { type, target: ORDINALS[(ordinal[1] ?? ordinal[2]).toLowerCase()] };
  if (/\b(?:last)\b/i.test(text)) return { type, target: 'last' };
  const named = text.match(/\b(?:to|for|at|of|from)\s+(?:the\s+)?([\p{L}\p{N} &'’.-]{2,120}?)[.!?]*$/iu)?.[1].trim();
  const planned = type === 'add_to_plan' ? text.match(PLAN_ADD)?.[1].trim() : undefined;
  if (planned !== undefined) {
    return /^(?:it|that|this|there|them|that one|this one|the place|place|one)$/i.test(planned) ? { type, target: 'it' } : { type, target: { name: planned } };
  }
  const saved = type === 'save' ? text.match(/^(?:please\s+|can you\s+|could you\s+)?(?:save|bookmark|favou?rite|remember)\s+(?:the\s+)?([\p{L}\p{N} &'’.-]{2,120}?)[.!?]*$/iu)?.[1].trim() : undefined;
  const name = named ?? saved;
  if (name && !/^(?:it|that|this|there|them|that one|this one|the place|place|one|my plan|a plan)$/i.test(name)
    && !/^(?:book|reserve|get|go)\b/i.test(name)) return { type, target: { name } };
  return { type, target: 'it' };
}

function normalizedName(text: string): string { return words(text).join(' '); }

function resolveActionTarget(target: ConciergeActionRequest['target'], cards: ConciergeCard[]): ConciergeCard | 'ambiguous' | null {
  if (typeof target === 'number') return cards[target - 1] ?? null;
  if (target === 'last') return cards.at(-1) ?? null;
  if (target === 'it') return cards.length === 1 ? cards[0] : 'ambiguous';
  const wanted = normalizedName(target.name);
  if (!wanted) return null;
  const matches = cards.filter((card) => {
    const name = normalizedName(card.name);
    return name === wanted || ` ${name} `.includes(` ${wanted} `) || ` ${wanted} `.includes(` ${name} `);
  });
  return matches.length === 1 ? matches[0] : matches.length ? 'ambiguous' : null;
}

const ACTION_CHOICES: Record<ConciergeActionType, (ordinal: string) => string> = {
  directions: (o) => `Directions to the ${o} one`, website: (o) => `Website for the ${o} one`,
  book_table: (o) => `Book a table at the ${o} one`, add_to_plan: (o) => `Add the ${o} one to my Plan`, save: (o) => `Save the ${o} one`,
};
const SUPPORTED_ACTIONS = 'Concierge can open directions, open a place website, open a hand-checked OpenTable or Resy link, add a place to one of your Plans, or save a place on this device. You approve each action first.';
const RIDE_REPLY = 'Concierge cannot book a ride. After you add a place to a Plan, the Plan shows Uber and Lyft links with that stop filled in; you book and pay for the ride in that app.';

function actionReply(type: ConciergeActionType, card: ConciergeCard): string {
  const approval = 'Nothing happens until you approve it.';
  if (type === 'directions') return `I can open directions to ${card.name}. ${approval}`;
  if (type === 'website') return `I can open the website for ${card.name}. A website is not a verified menu. ${approval}`;
  if (type === 'save') return `I can save ${card.name} on this device. ${approval}`;
  if (type === 'add_to_plan') return `I can add ${card.name} to a Plan you choose. It is added as a reference, not a booking. After that, Concierge can help you get there. ${approval}`;
  const booking = card.actions.find((a) => a.type === 'book_table');
  const label = booking && 'label' in booking ? booking.label : 'the booking provider';
  return `I can open ${label} for ${card.name}. You book with ${label}; Bytspot does not make or confirm the booking. ${approval}`;
}

function missingActionReply(type: ConciergeActionType, card: ConciergeCard): string {
  if (type === 'book_table') return `Bytspot has no hand-checked OpenTable or Resy link for ${card.name}, so Concierge cannot book a table there.`;
  if (type === 'website') return `Bytspot has no website it can open for ${card.name}.`;
  return `That action is not available for ${card.name}.`;
}

type LocalPlan = Omit<ConciergePlan, 'query' | 'rail' | 'mode'> & {
  search: ConciergeSearch; blocked: boolean; exclusions: string[]; messages: string[]; locationConfirmed: boolean;
  action: ConciergeActionRequest | null;
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
  let action: ConciergeActionRequest | null = null;
  for (const message of input.messages.filter((m) => m.role === 'user')) {
    let text = message.content.trim();
    action = null;
    // An act on shown results keeps the earlier search; it is never search text or location consent.
    const requested = messages.length ? conciergeActionRequest(text) : null;
    if (requested) { action = requested; continue; }
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
    needsLocation, budget, menu, openNow, firstStop, blocked, exclusions, messages, locationConfirmed, action,
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

function result(status: ConciergeResponse['status'], reply: string, cards: ConciergeCard[] = [], refinements: string[] = [],
  proposal: ConciergeResponse['proposal'] = null): ConciergeResponse {
  return conciergeDiscoverOutput.parse({ version: 1, status, reply, cards, refinements, proposal });
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
    // Only hand-checked links become a booking action. A failed lookup offers none.
    let bookings = new Map<string, TableBookingLink>();
    const bookingIds = [...new Set([...venues.map((v) => v.googlePlaceId), ...places.map((p) => p.placeId)]
      .filter((id): id is string => id !== null))];
    if (dependencies.tableBookings && bookingIds.length) {
      try { bookings = await withDeadline(dependencies.tableBookings(bookingIds), 1000); } catch { bookings = new Map(); }
    }
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
      const websiteUrl = stale ? null : conciergeWebsiteURL(p?.websiteUri);
      const booking = conciergeActionSchema.safeParse({ type: 'book_table', ...(placeId ? bookings.get(placeId) : undefined) });
      const actions: ConciergeAction[] = [{ type: 'directions' }, ...(websiteUrl ? [{ type: 'website' as const }] : []),
        ...(placeId && booking.success ? [booking.data] : []), { type: 'add_to_plan' }, { type: 'save' }];
      cards.push({ id, kind: v ? 'venue' : 'place', placeId, name: spot.name, address: typeof spot.address === 'string' ? spot.address : '',
        lat: spot.lat, lng: spot.lng, category, rating, isOpen: stale || typeof p?.isOpen !== 'boolean' ? null : p.isOpen,
        photoUrl: null, crowd: null, reasons, capability: 'details',
        source: v ? 'bytspot' : stale ? 'google-stale' : 'google', rail: actualRail,
        menuEvidence, websiteUrl, actions });
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
      plan.firstStop ? 'This searches a first stop for tonight. You can add a place to one of your Plans; Concierge does not make bookings.' : '',
      'Search terms guide discovery, but listing matches do not verify every requested preference.',
    ].filter(Boolean).join(' ');
    if (!selected.length) return result(failed || stale || menuFailed ? 'unavailable' : 'empty',
      `${failed || stale || menuFailed ? 'I could not verify matching places nearby. Please try again.' : `No matching places were found within ${search.radius} m of your supplied location.`} ${caveats}`,
      [], ['Coffee nearby', 'Restaurants nearby']);
    const refinements = ['Closer', 'Coffee nearby', 'Restaurants nearby'];
    const requested = plan.action;
    if (requested) {
      if (requested.type === 'unsupported') return result('ready', `Concierge cannot do that for you. ${SUPPORTED_ACTIONS} ${caveats}`, selected, refinements);
      if (requested.type === 'ride') return result('ready', `${RIDE_REPLY} ${SUPPORTED_ACTIONS} ${caveats}`, selected,
        selected.map((_, index) => ACTION_CHOICES.add_to_plan(['first', 'second', 'third'][index])));
      const target = resolveActionTarget(requested.target, selected);
      const choices = selected.map((_, index) => ACTION_CHOICES[requested.type as ConciergeActionType](['first', 'second', 'third'][index]));
      if (target === 'ambiguous' || target === null) return result('ready',
        `${target === null ? 'I could not match that to a place shown.' : 'Which place?'} Say “first”, “second” or “third”. ${caveats}`, selected, choices);
      if (!target.actions.some((a) => a.type === requested.type)) {
        return result('ready', `${missingActionReply(requested.type, target)} ${SUPPORTED_ACTIONS} ${caveats}`, selected, refinements);
      }
      return result('ready', `${actionReply(requested.type, target)} ${caveats}`, selected, refinements,
        { type: requested.type, cardId: target.id });
    }
    return result('ready', `Here are nearby place listings within ${search.radius} m of your supplied location. Details only; availability is not guaranteed. ${caveats}`,
      selected, refinements);
  };
}
