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
  | 'need-not-open'
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

/**
 * The Plan need a demand category came from — the inverse of the map above.
 *
 * Built by inverting rather than restated, so the two can never disagree. The
 * pairing is one-to-one, which is what makes the inverse well defined; a
 * second need mapping onto an existing category would make this ambiguous, so
 * it is asserted rather than assumed.
 */
const NEED_FOR_CATEGORY: Readonly<Record<string, string>> = Object.freeze(
  Object.entries(CATEGORY_FOR_NEED).reduce<Record<string, string>>((acc, [need, category]) => {
    if (acc[category]) throw new Error(`Two needs claim the demand category ${category}`);
    acc[category] = need;
    return acc;
  }, {}),
);

/**
 * The Plan need a demand answers, when the category names one.
 *
 * A demand raised straight from Concierge may carry a category no Plan need
 * maps onto. That is not an error; it means a booking won against it has no
 * honest place in a Plan's need list, so the caller declines to file it rather
 * than inventing a need the guest never stated.
 */
export function needKindForDemandCategory(category: string): string | undefined {
  return NEED_FOR_CATEGORY[category];
}

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

/**
 * A need as the Plan states it.
 *
 * Keyed by kind rather than by item because a Plan can declare a need nothing
 * has been attached to yet — "dinner" with no restaurant chosen is the most
 * common thing to want help with, and it has no item at all.
 */
export interface EmittingNeed {
  kind: string;
  /** Still unmet, as the Plan itself reports it. */
  open: boolean;
}

/**
 * What a Plan would ask for on behalf of one of its unfilled needs.
 */
export function constraintsFromPlan(plan: EmittingPlan, need: EmittingNeed, now: Date): Emission {
  // Already met, cancelled, or not a need this Plan has. Asking would hold
  // capacity nobody needs and answer a question the guest stopped asking.
  if (!need.open) return { ok: false, reason: 'need-not-open' };

  const category = demandCategoryForNeed(need.kind);
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
    case 'need-not-open':
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
