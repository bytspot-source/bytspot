import { DEMAND_DEFAULTS, demandCategoryIds } from './demand';

/**
 * A Plan's unmet need, stated as demand.
 *
 * A Plan already carries everything a demand asks for — when, where, how many —
 * so an unfilled need in a Plan is a request nobody has written down yet. This
 * turns one into the other, and refuses when the Plan does not actually say
 * enough to ask on the guest's behalf.
 *
 * Every refusal carries its reason. A Plan that cannot emit is not an error to
 * swallow: it is the difference between "no vendor answered" and "we never
 * asked", and a guest is owed that distinction.
 */

export type EmissionRefusal =
  | 'item-cancelled'
  | 'item-filled'
  | 'category-unmappable'
  | 'no-window'
  | 'window-passed'
  | 'no-location'
  | 'no-party-size';

export interface DemandEnvelope {
  category: string;
  partySize: number;
  earliest: Date;
  latest: Date;
  latitude: number;
  longitude: number;
}

export type Emission =
  | { ok: true; envelope: DemandEnvelope }
  | { ok: false; reason: EmissionRefusal };

/**
 * Plans and demand name their categories differently, and only some of them
 * mean the same thing. The pairs below are the ones that do.
 *
 * The rest are deliberately absent. `automotive` could be parking, valet or a
 * service; `wellness` could be fitness or a service; `green` and `stall` have
 * no demand category at all. Picking one would publish a request to the wrong
 * sellers and read, to the guest, as Bytspot having misunderstood them.
 */
const CATEGORY_FOR_NEED: Readonly<Record<string, string>> = {
  coffee: 'coffee',
  dining: 'dining',
  nightlife: 'nightlife',
  shopping: 'shopping',
  fitness: 'fitness',
  events: 'entertainment',
  stay: 'boutique_apartment',
};

/** The demand category a Plan need maps onto, when one honestly does. */
export function demandCategoryForNeed(needKind: string): string | undefined {
  const mapped = CATEGORY_FOR_NEED[needKind];
  // Guarded against the contract rather than trusted: if a category is renamed
  // there, this map must fail closed instead of publishing an id no seller has.
  return mapped && demandCategoryIds().includes(mapped) ? mapped : undefined;
}

export interface EmittingPlan {
  startsAt: Date | null;
  endsAt: Date | null;
  latitude: number | null;
  longitude: number | null;
  partySize: number | null;
}

export interface EmittingItem {
  needKind: string;
  status: string;
  bookableId: string | null;
}

/**
 * What a Plan would ask for on behalf of one of its unfilled needs.
 */
export function constraintsFromPlan(plan: EmittingPlan, item: EmittingItem, now: Date): Emission {
  if (item.status === 'cancelled') return { ok: false, reason: 'item-cancelled' };
  // Supply already found. Asking again would hold capacity the guest does not
  // need and answer a question they have stopped asking.
  if (item.bookableId) return { ok: false, reason: 'item-filled' };

  const category = demandCategoryForNeed(item.needKind);
  if (!category) return { ok: false, reason: 'category-unmappable' };

  if (!plan.startsAt) return { ok: false, reason: 'no-window' };

  // A Plan with a start but no end is a real Plan, not a broken one. The
  // contract's flexibility is what it already allows either side of a slot, so
  // it is the honest width to read a bare start time as — rather than inventing
  // an evening's length.
  const latest = plan.endsAt ?? new Date(plan.startsAt.getTime() + DEMAND_DEFAULTS.flexibilityMins * 60_000);
  if (latest <= plan.startsAt) return { ok: false, reason: 'no-window' };
  if (latest <= now) return { ok: false, reason: 'window-passed' };

  // A Plan that has already begun can still have unmet needs, but nobody can
  // supply the part that has passed, so the ask starts from now.
  const earliest = plan.startsAt > now ? plan.startsAt : now;

  if (plan.latitude === null || plan.longitude === null) return { ok: false, reason: 'no-location' };
  // Null Island is a failed geolocation, not a place a Plan is happening.
  if (plan.latitude === 0 && plan.longitude === 0) return { ok: false, reason: 'no-location' };

  // Not defaulted to one. Capacity is a match rule, so a guessed party size
  // returns offers that cannot seat the group — worse than not asking, because
  // the guest believes a table is waiting.
  if (!plan.partySize || plan.partySize < 1) return { ok: false, reason: 'no-party-size' };

  return {
    ok: true,
    envelope: {
      category,
      partySize: Math.min(plan.partySize, DEMAND_DEFAULTS.maxPartySize),
      earliest,
      latest,
      latitude: plan.latitude,
      longitude: plan.longitude,
    },
  };
}

/** What to tell the guest when a Plan cannot ask on their behalf. */
export function refusalMessage(reason: EmissionRefusal): string {
  switch (reason) {
    case 'item-cancelled':
      return 'That part of the plan was cancelled.';
    case 'item-filled':
      return 'That part of the plan is already sorted.';
    case 'category-unmappable':
      return 'We cannot ask vendors for that yet.';
    case 'no-window':
      return 'Add a time to the plan first.';
    case 'window-passed':
      return 'That part of the plan has already passed.';
    case 'no-location':
      return 'Add where the plan is happening first.';
    case 'no-party-size':
      return 'Say how many people are coming first.';
  }
}
