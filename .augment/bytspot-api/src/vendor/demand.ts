import bookableTemplates from './contracts/bookable-templates.json';
import { sellableSlots, type DerivedSlot } from './availability';

/**
 * The match rules, server side.
 *
 * The console already runs these to decide what to show a vendor. They are here
 * too because a demand's state is the server's to keep: OPEN means nobody can
 * answer it yet, and MATCHED means somebody can. Deciding that in the browser
 * would let a console that had not refreshed offer against capacity that had
 * already gone.
 *
 * Every rule is evaluated and every failure collected, never short-circuited.
 * Demand nobody could answer is the most useful half of the feed, and it is
 * only useful with the reason attached.
 */

const demandContract = bookableTemplates.demand;
const categories = bookableTemplates.discoverCategories;

export type DemandState = 'OPEN' | 'MATCHED' | 'OFFERED' | 'BOOKED' | 'EXPIRED' | 'WITHDRAWN';
export type DemandOperationId = 'OFFER' | 'WITHDRAW_OFFER' | 'DECLINE';
export type MatchRuleId = 'category' | 'location' | 'party' | 'budget' | 'capacity';

export const DEMAND_DEFAULTS = demandContract.defaults;

export function demandCategoryIds(): string[] {
  return categories.map((category) => category.id);
}

export function domainsForCategory(id: string): string[] {
  return categories.find((category) => category.id === id)?.domains ?? [];
}

/** The demand category an ask about a window of this domain is raised under. */
export function categoryForDomain(domain: string): string | undefined {
  return categories.find((category) => category.domains.includes(domain))?.id;
}

export function isActionable(state: string): boolean {
  return demandContract.actionableStates.includes(state);
}

export function demandOperation(id: string) {
  return demandContract.operations.find((operation) => operation.id === id);
}

/** What a demand asks for, reduced to the fields the rules actually read. */
export interface EvaluableDemand {
  id: string;
  category: string;
  state: string;
  partySize: number;
  earliest: Date;
  latest: Date;
  latitude: number;
  longitude: number;
  radiusMiles: number;
  budgetCents: number | null;
}

/** What a seller could answer it from. */
export interface EvaluableSupply {
  windowId: string;
  domain: string;
  latitude: number;
  longitude: number;
  /** Set only when the seller is the one travelling. */
  serviceRadiusMiles: number | null;
  priceCents: number;
  maxGuests: number;
  slots: DerivedSlot[];
}

export interface DemandMiss {
  rule: MatchRuleId;
  reason: string;
}

export interface DemandEvaluation {
  windowId: string;
  matched: boolean;
  misses: DemandMiss[];
  slots: DerivedSlot[];
  distanceMiles: number;
}

function miss(rule: MatchRuleId): DemandMiss {
  return { rule, reason: demandContract.matchRules.find((item) => item.id === rule)?.missReason ?? rule };
}

const EARTH_RADIUS_MILES = 3958.8;

export function distanceMiles(
  from: { latitude: number; longitude: number },
  to: { latitude: number; longitude: number },
): number {
  const toRadians = (degrees: number): number => (degrees * Math.PI) / 180;
  const deltaLat = toRadians(to.latitude - from.latitude);
  const deltaLng = toRadians(to.longitude - from.longitude);
  const a =
    Math.sin(deltaLat / 2) ** 2 +
    Math.cos(toRadians(from.latitude)) * Math.cos(toRadians(to.latitude)) * Math.sin(deltaLng / 2) ** 2;
  return 2 * EARTH_RADIUS_MILES * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** The window the guest will accept, widened by the contract's flexibility. */
export function demandWindow(demand: EvaluableDemand): { from: Date; to: Date } {
  const slack = DEMAND_DEFAULTS.flexibilityMins * 60_000;
  return { from: new Date(demand.earliest.getTime() - slack), to: new Date(demand.latest.getTime() + slack) };
}

/**
 * A slot can absorb a party only if it has room for all of it. Splitting six
 * across two tables is a different product, not a match.
 */
export function slotsForDemand(demand: EvaluableDemand, supply: EvaluableSupply, now?: Date): DerivedSlot[] {
  const { from, to } = demandWindow(demand);
  return sellableSlots(supply.slots, supply.domain, now)
    .filter((slot) => slot.startsAt >= from && slot.startsAt <= to && slot.remaining >= demand.partySize)
    .sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
}

/** Either side may be the one who travels, so reach is the wider of the two. */
function withinReach(demand: EvaluableDemand, supply: EvaluableSupply): { ok: boolean; distance: number } {
  const distance = distanceMiles(demand, supply);
  const reach = Math.max(demand.radiusMiles, supply.serviceRadiusMiles ?? 0);
  return { ok: distance <= reach, distance };
}

export function evaluateDemand(demand: EvaluableDemand, supply: EvaluableSupply, now?: Date): DemandEvaluation {
  const misses: DemandMiss[] = [];

  if (!domainsForCategory(demand.category).includes(supply.domain)) misses.push(miss('category'));

  const reach = withinReach(demand, supply);
  if (!reach.ok) misses.push(miss('location'));

  if (demand.partySize > supply.maxGuests) misses.push(miss('party'));

  if (demand.budgetCents !== null && supply.priceCents > demand.budgetCents) misses.push(miss('budget'));

  // Last, and the only rule that reads availability. Without it a match is a
  // category guess dressed up as an answer.
  const slots = slotsForDemand(demand, supply, now);
  if (!slots.length) misses.push(miss('capacity'));

  return {
    windowId: supply.windowId,
    matched: misses.length === 0,
    misses,
    slots,
    distanceMiles: Math.round(10 * reach.distance) / 10,
  };
}

/** True when at least one of this seller's windows can actually answer. */
export function anyMatch(demand: EvaluableDemand, supply: EvaluableSupply[], now?: Date): boolean {
  return supply.some((item) => evaluateDemand(demand, item, now).matched);
}

/**
 * Whether an operation is legal, asked of the contract rather than of a switch
 * statement, so the console and the API cannot drift on what a seller may do.
 */
export function canRunDemandOperation(operation: string, state: string, capabilities: string[]): boolean {
  const target = demandOperation(operation);
  if (!target) return false;
  if (!capabilities.includes(target.requiresCapability)) return false;
  return target.from.includes(state);
}

export function stateAfterOperation(operation: string): string | null {
  return demandOperation(operation)?.to ?? null;
}
