import { z } from 'zod';
import type { ClassifiedArea } from './area';
import type { AtlantaClock } from './clock';

/** Needs a starter may mention. Matches Concierge plan needs, not every Bookable category. */
export const SUGGESTION_NEEDS = ['coffee', 'dining', 'nightlife', 'events'] as const;
export type SuggestionNeed = typeof SUGGESTION_NEEDS[number];

export const SUGGESTION_IDS = [
  'plan_the_night', 'coffee_nearby', 'lunch_nearby', 'dinner_nearby',
  'drinks_nearby', 'events_nearby', 'plan_a_show', 'share_plan',
] as const;
export type SuggestionId = typeof SUGGESTION_IDS[number];

export const TYPICAL_NOTE = 'Typical for this hour in Atlanta, not a live reading.' as const;

/** The sentence the night chip leads with. The guest still confirms and shares the Plan. */
export const PLAN_THE_NIGHT_STORY = 'Plan the night. Send one link. Everyone\'s in.';

export interface UpcomingPlanFact {
  id: string;
  title: string;
  startsAt: string | null;
  areaLabel: string | null;
}

export interface TypicalFact { level: number; label: string }

export interface PrimePathFact {
  status: 'ok' | 'unavailable';
  confirmableNeeds: SuggestionNeed[];
}

/** Ports the suggestion skills read. Failures become empty or `unavailable`, never invented facts. */
export interface SuggestionPorts {
  upcomingPlans(userId: string, now: Date): Promise<UpcomingPlanFact[]>;
  recentNeeds(userId: string, now: Date): Promise<string[]>;
  typical(input: { hour: number; dayOfWeek: number; category: string }): Promise<TypicalFact | null>;
  primePath(input: { userId: string | null; latitude: number | null; longitude: number | null; now: string }): Promise<PrimePathFact>;
}

export interface SuggestionFacts {
  now: string;
  userId: string | null;
  planRouteEnabled: boolean;
  clock: AtlantaClock;
  area: ClassifiedArea;
  plans: UpcomingPlanFact[];
  recentNeeds: string[];
  typical: {
    coffee: TypicalFact | null;
    restaurant: TypicalFact | null;
    bar: TypicalFact | null;
    /** Bar curve at the hour the night chip is about (10 PM, or now once it's evening). */
    barNight: TypicalFact | null;
    venue: TypicalFact | null;
  };
  nightHour: number;
  primePath: PrimePathFact;
}

export interface SuggestionPick { id: SuggestionId; planId: string | null }

export const suggestionPickSchema = z.object({
  id: z.enum(SUGGESTION_IDS),
  planId: z.string().min(1).nullable(),
}).strict();

export const suggestionPicksSchema = z.object({
  picks: z.array(suggestionPickSchema).min(1).max(4),
}).strict();

const typicalSchema = z.object({
  category: z.enum(['coffee', 'restaurant', 'bar', 'venue']),
  level: z.number().int().min(1).max(4),
  label: z.string().min(1).max(20),
  source: z.literal('typical'),
  note: z.literal(TYPICAL_NOTE),
  hourLabel: z.string().regex(/^around (this hour|\d{1,2} (AM|PM))$/),
}).strict();

const primeOnSuggestionSchema = z.object({
  consulted: z.boolean(),
  confirmableNeeds: z.array(z.enum(SUGGESTION_NEEDS)).max(4),
  note: z.string().min(1).max(240).nullable(),
}).strict().refine((value) => (value.note === null) === (value.confirmableNeeds.length === 0), 'A Prime Path note exists only when a need on this prompt is confirmable');

export const conciergeSuggestionSchema = z.object({
  id: z.enum(SUGGESTION_IDS),
  label: z.string().min(1).max(40),
  /** Text the client sends. For share_plan the client opens planId instead. */
  prompt: z.string().min(1).max(200),
  reason: z.string().min(1).max(320),
  destination: z.enum(['discover', 'concierge_plan', 'share_plan']),
  /** True when `prompt` is a Plan request `concierge.discover` or `concierge.plan` can run. */
  startsPlan: z.boolean(),
  planId: z.string().min(1).nullable(),
  typical: typicalSchema.nullable(),
  primePath: primeOnSuggestionSchema,
}).strict().superRefine((suggestion, ctx) => {
  if (/\bbusy right now\b|\blive crowd\b|\bspots left\b/i.test(suggestion.reason)) {
    ctx.addIssue({ code: 'custom', message: 'A suggestion reason must not claim a live crowd or scarcity' });
  }
  if (suggestion.typical && !suggestion.reason.includes(TYPICAL_NOTE)) {
    ctx.addIssue({ code: 'custom', message: 'Typical busyness in the reason must say it is not live' });
  }
  if (suggestion.id === 'plan_the_night' && !suggestion.reason.includes(PLAN_THE_NIGHT_STORY)) {
    ctx.addIssue({ code: 'custom', message: 'The night chip carries the Plan story' });
  }
  if (suggestion.destination === 'share_plan') {
    if (suggestion.startsPlan || suggestion.planId === null || suggestion.typical !== null) {
      ctx.addIssue({ code: 'custom', message: 'A share chip opens an existing Plan' });
    }
  } else if (suggestion.startsPlan) {
    if (suggestion.planId !== null) ctx.addIssue({ code: 'custom', message: 'A new Plan chip has no plan id' });
  } else if (suggestion.planId !== null) {
    ctx.addIssue({ code: 'custom', message: 'Only a share chip carries a plan id' });
  }
});

export const conciergeSuggestionsOkSchema = z.object({
  version: z.literal(1),
  status: z.literal('ok'),
  source: z.enum(['si', 'curated']),
  reply: z.null(),
  area: z.object({
    label: z.string().nullable(),
    basis: z.enum(['coordinates', 'launch_market']),
    sentence: z.string().min(1),
  }).strict(),
  when: z.object({
    timezone: z.literal('America/New_York'),
    hour: z.number().int().min(0).max(23),
    dayOfWeek: z.number().int().min(0).max(6),
    weekday: z.string().min(1),
  }).strict(),
  primePath: z.object({
    status: z.enum(['ok', 'unavailable']),
    confirmableNeeds: z.array(z.enum(SUGGESTION_NEEDS)).max(4),
  }).strict().refine((value) => value.status === 'ok' || value.confirmableNeeds.length === 0, 'Unknown Prime Path is not an empty confirmed list'),
  suggestions: z.array(conciergeSuggestionSchema).min(1).max(3),
}).strict().refine((value) => value.suggestions.some((suggestion) => suggestion.startsPlan), 'The list includes a Plan');

export type ConciergeSuggestionsOk = z.infer<typeof conciergeSuggestionsOkSchema>;

export const emptyPorts: SuggestionPorts = {
  upcomingPlans: async () => [],
  recentNeeds: async () => [],
  typical: async () => null,
  primePath: async () => ({ status: 'unavailable', confirmableNeeds: [] }),
};
