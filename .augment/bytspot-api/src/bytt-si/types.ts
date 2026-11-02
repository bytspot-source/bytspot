import { z } from 'zod';

/**
 * Field names mirror bytspot-api prisma `Plan` / `PlanItem` / `Bookable`
 * (areaLabel, latitude/longitude, startsAt/endsAt, partySize, budgetCents,
 * radiusMiles, needs[], items[], placeLat/placeLng, capability, bookableId).
 */

export const MIDTOWN = { areaLabel: 'Midtown, Atlanta', latitude: 33.7838, longitude: -84.3830 } as const;
export const DEFAULT_RADIUS_MILES = 1.5;
export const TIMEZONE = 'America/New_York';

export const NEED_KINDS = ['dining', 'drinks', 'nightlife', 'event', 'coffee', 'activity', 'parking', 'ride'] as const;
export type NeedKind = typeof NEED_KINDS[number];

const isoDateTime = z.iso.datetime({ offset: true });

/** What the guest asked for, normalized. Same meaning as the backend Plan columns. */
export const planConstraintsSchema = z.object({
  intent: z.string().min(1),
  startsAt: isoDateTime.nullable(),
  endsAt: isoDateTime.nullable(),
  areaLabel: z.string().nullable(),
  latitude: z.number().min(-90).max(90).nullable(),
  longitude: z.number().min(-180).max(180).nullable(),
  partySize: z.number().int().min(1).max(50).nullable(),
  /** Total ceiling for the whole group, like Plan.budgetCents. Null = no budget (not zero). */
  budgetCents: z.number().int().min(0).nullable(),
  radiusMiles: z.number().positive().max(50).nullable(),
  needs: z.array(z.string()),
  preferences: z.array(z.string()),
});
export type PlanConstraints = z.infer<typeof planConstraintsSchema>;

export interface ConciergeRequest {
  message: string;
  /** ISO timestamp used to resolve "tonight", "Friday". Injected for determinism. */
  now: string;
  userId?: string;
  areaLabel?: string;
  latitude?: number;
  longitude?: number;
  preferences?: string[];
}

export type CrowdSource = 'typical' | 'live';
export interface CrowdInfo {
  level: number; // 0..4, same scale as CrowdLevel
  source: CrowdSource;
  /** Guest-facing label generated in code. Typical data is always labeled typical. */
  label: string;
  observedAt: string | null;
}

export type PriceBasis = 'bytspot_bookable' | 'provider_listed' | 'estimate';

export type BookingOption =
  | { kind: 'bytspot'; bookableId: string; capability: string; tierName: string; priceCents: number | null; capacity: number | null }
  | { kind: 'deeplink'; provider: 'opentable' | 'resy'; label: string; url: string; availabilityChecked: false };

export interface RideLink { provider: 'uber' | 'lyft'; url: string; fareChecked: false }

export interface ProposedPlanItem {
  position: number;
  needKind: string;
  title: string;
  candidateId: string;
  placeId: string | null;
  placeName: string;
  placeAddress: string | null;
  placeLat: number;
  placeLng: number;
  startsAt: string | null;
  durationMins: number | null;
  /** 'fixed' = the supply states it (event); 'scheduled' = engine placed it; 'model' = model's time passed checks. */
  timeSource: 'fixed' | 'scheduled' | 'model';
  travelMinsBefore: number | null;
  /** Per person. Null = unknown, never zero-by-default. */
  priceCents: number | null;
  priceBasis: PriceBasis | null;
  capability: 'details' | 'request' | 'book';
  crowd: CrowdInfo | null;
  booking: BookingOption[];
  rides: RideLink[];
}

export type Verdict = 'fits' | 'breaks' | 'unknown';
export interface CheckResult { check: 'window' | 'overlap' | 'travel' | 'budget' | 'capacity'; verdict: Verdict; detail: string }

export type NoticeCode =
  | 'provider_unavailable' | 'provider_stale' | 'assistant_unavailable' | 'dropped_unverified_item'
  | 'budget_repaired' | 'over_budget' | 'price_unknown' | 'price_estimate'
  | 'schedule_adjusted' | 'schedule_infeasible' | 'typical_not_live' | 'deeplink_only'
  | 'step_cap' | 'text_replaced' | 'no_options' | 'assumption' | 'final_check';
export interface Notice { code: NoticeCode; message: string }

export interface BudgetSummary {
  verdict: Verdict;
  budgetCents: number | null;
  perPersonCents: number | null;
  totalCents: number | null;
  basis: 'exact' | 'estimate' | 'unknown';
  detail: string;
}

export interface ProposedPlan extends PlanConstraints {
  kind: 'plan';
  /** 'proposed' = checks pass or are unknown; 'needs_changes' = a hard check breaks. */
  status: 'proposed' | 'needs_changes';
  lifecycle: 'proposed';
  title: string;
  summary: string;
  items: ProposedPlanItem[];
  feasibility: { verdict: Verdict; checks: CheckResult[] };
  budget: BudgetSummary;
  notices: Notice[];
  actions: {
    edit: { available: true };
    /** One link: created by the backend (plans.create returns the joinToken link). */
    share: { available: boolean; via: 'plans.create' };
    book: { available: boolean; reason: string | null };
  };
  meta: { provider: string; steps: number; toolCalls: string[] };
}

export interface QuickAnswer {
  kind: 'quick_answer';
  answer: string;
  notices: Notice[];
  makePlanSuggestion: { label: string; prefill: PlanConstraints };
  meta: { provider: string; steps: number; toolCalls: string[] };
}

export type ConciergeResult = ProposedPlan | QuickAnswer;

// ─── Wire contract (tRPC output) ─────────────────────────────────────────────
const verdictSchema = z.enum(['fits', 'breaks', 'unknown']);
const noticeSchema = z.object({ code: z.string(), message: z.string() }).strict();
const metaSchema = z.object({ provider: z.string(), steps: z.number().int(), toolCalls: z.array(z.string()) }).strict();
const crowdSchema = z.object({ level: z.number(), source: z.enum(['typical', 'live']), label: z.string(), observedAt: z.string().nullable() }).strict();
const bookingSchema = z.union([
  z.object({ kind: z.literal('bytspot'), bookableId: z.string(), capability: z.string(), tierName: z.string(), priceCents: z.number().int().nullable(), capacity: z.number().int().nullable() }).strict(),
  z.object({ kind: z.literal('deeplink'), provider: z.enum(['opentable', 'resy']), label: z.string(), url: z.string(), availabilityChecked: z.literal(false) }).strict(),
]);
const itemSchema = z.object({
  position: z.number().int(), needKind: z.string(), title: z.string(), candidateId: z.string(),
  placeId: z.string().nullable(), placeName: z.string(), placeAddress: z.string().nullable(), placeLat: z.number(), placeLng: z.number(),
  startsAt: z.string().nullable(), durationMins: z.number().nullable(), timeSource: z.enum(['fixed', 'scheduled', 'model']), travelMinsBefore: z.number().nullable(),
  priceCents: z.number().int().nullable(), priceBasis: z.enum(['bytspot_bookable', 'provider_listed', 'estimate']).nullable(),
  capability: z.enum(['details', 'request', 'book']), crowd: crowdSchema.nullable(), booking: z.array(bookingSchema),
  rides: z.array(z.object({ provider: z.enum(['uber', 'lyft']), url: z.string(), fareChecked: z.literal(false) }).strict()),
}).strict();
export const proposedPlanSchema = planConstraintsSchema.extend({
  kind: z.literal('plan'), status: z.enum(['proposed', 'needs_changes']), lifecycle: z.literal('proposed'),
  title: z.string(), summary: z.string(), items: z.array(itemSchema),
  feasibility: z.object({ verdict: verdictSchema, checks: z.array(z.object({ check: z.enum(['window', 'overlap', 'travel', 'budget', 'capacity']), verdict: verdictSchema, detail: z.string() }).strict()) }).strict(),
  budget: z.object({ verdict: verdictSchema, budgetCents: z.number().nullable(), perPersonCents: z.number().nullable(), totalCents: z.number().nullable(), basis: z.enum(['exact', 'estimate', 'unknown']), detail: z.string() }).strict(),
  notices: z.array(noticeSchema),
  actions: z.object({
    edit: z.object({ available: z.literal(true) }).strict(),
    share: z.object({ available: z.boolean(), via: z.literal('plans.create') }).strict(),
    book: z.object({ available: z.boolean(), reason: z.string().nullable() }).strict(),
  }).strict(),
  meta: metaSchema,
}).strict();
export const quickAnswerResultSchema = z.object({
  kind: z.literal('quick_answer'), answer: z.string(), notices: z.array(noticeSchema),
  makePlanSuggestion: z.object({ label: z.string(), prefill: planConstraintsSchema }).strict(), meta: metaSchema,
}).strict();
export const conciergeResultSchema = z.discriminatedUnion('kind', [proposedPlanSchema, quickAnswerResultSchema]);
