import { distanceMeters } from './checkinProof';
import type { PlanLeg } from './planLegs';

/**
 * Does this Plan actually work?
 *
 * Five questions — does each leg sit inside the window, do two legs overlap,
 * can the group physically get between them, does it cost more than they said,
 * and does it seat everyone. Each is answered separately, and each answer is
 * one of three things:
 *
 *   fits    — checked, and it holds
 *   breaks  — checked, and it does not
 *   unknown — not checked, because the facts to check it were never supplied
 *
 * The third value is the whole point. Two legs where nobody stated a duration
 * are not two legs that fit; they are two legs nobody can judge. Collapsing
 * that into `fits` tells the guest their evening works when nothing of the
 * sort has been established, and collapsing it into `breaks` invents a problem.
 * A checker that cannot see enough says so and names what is missing.
 *
 * This is a pure function of legs and constraints — no clock, no database, no
 * network — so the same Plan always produces the same verdict.
 */
export type Verdict = 'fits' | 'breaks' | 'unknown';

export type CheckName = 'window' | 'overlap' | 'travel' | 'budget' | 'capacity';

export interface CheckResult {
  check: CheckName;
  verdict: Verdict;
  /** Plain sentence, safe to show a guest. Always present, including for `fits`. */
  detail: string;
  /** Items the verdict is about, so the UI can point rather than gesture. */
  itemIds: string[];
}

export interface PlanFeasibility {
  /** `breaks` if any check breaks; else `unknown` if any is unknown; else `fits`.
   *  Unknown never outranks a break: a Plan with one impossible leg is broken
   *  whatever else is unstated. */
  verdict: Verdict;
  checks: CheckResult[];
}

export interface PlanConstraints {
  startsAt: Date | null;
  endsAt: Date | null;
  partySize: number | null;
  budgetCents: number | null;
}

/**
 * Deliberately generous: 45 mph door to door, ignoring parking, lights and the
 * walk in. Real city travel is far slower, but a travel *estimate* is a guess,
 * and a guess must never be the thing that tells a guest their evening is
 * impossible. At this speed `breaks` means the gap fails even at a pace no one
 * will actually achieve — so it is a floor on impossibility, not a prediction.
 * Anything short of that is left alone rather than warned about.
 */
const OPTIMISTIC_TRAVEL_METERS_PER_MIN = 1207;

const fits = (check: CheckName, detail: string, itemIds: string[] = []): CheckResult =>
  ({ check, verdict: 'fits', detail, itemIds });
const breaks = (check: CheckName, detail: string, itemIds: string[]): CheckResult =>
  ({ check, verdict: 'breaks', detail, itemIds });
const unknown = (check: CheckName, detail: string, itemIds: string[] = []): CheckResult =>
  ({ check, verdict: 'unknown', detail, itemIds });

const clockLabel = (at: Date) =>
  at.toISOString().slice(11, 16);

/** Minutes a leg occupies, or null when its length was never stated. */
function endOf(leg: PlanLeg): Date | null {
  if (!leg.startsAt || leg.durationMins === null) return null;
  return new Date(leg.startsAt.getTime() + leg.durationMins * 60_000);
}

function placed(leg: PlanLeg): boolean {
  return leg.latitude !== null && leg.longitude !== null;
}

/** Every leg inside the Plan's window. */
function checkWindow(legs: readonly PlanLeg[], plan: PlanConstraints): CheckResult {
  if (!plan.startsAt || !plan.endsAt) {
    return unknown('window', 'This Plan has no start and end time yet, so nothing can be checked against it.');
  }
  const timed = legs.filter((leg) => leg.startsAt);
  if (timed.length === 0) {
    return unknown('window', 'None of these have a stated time, so none can be placed in the window.');
  }

  const outside = timed.filter((leg) => {
    const start = leg.startsAt!;
    if (start < plan.startsAt! || start > plan.endsAt!) return true;
    const end = endOf(leg);
    return end !== null && end > plan.endsAt!;
  });
  if (outside.length > 0) {
    const names = outside.map((leg) => leg.title).join(', ');
    return breaks('window', `${names} falls outside the time you set for this Plan.`,
      outside.map((leg) => leg.itemId));
  }

  const untimed = legs.filter((leg) => !leg.startsAt);
  if (untimed.length > 0) {
    return unknown('window',
      `${untimed.map((leg) => leg.title).join(', ')} has no stated time, so only the rest could be checked.`,
      untimed.map((leg) => leg.itemId));
  }
  return fits('window', 'Everything here sits inside the time you set.');
}

/** No two legs claiming the same minutes. */
function checkOverlap(legs: readonly PlanLeg[]): CheckResult {
  // A leg needs both a start and a length before it occupies anything. One
  // with a start but no duration is a point, not a span, and a point cannot be
  // shown to clash.
  const spans = legs
    .map((leg) => ({ leg, start: leg.startsAt, end: endOf(leg) }))
    .filter((span): span is { leg: PlanLeg; start: Date; end: Date } => span.start !== null && span.end !== null)
    .sort((a, b) => a.start.getTime() - b.start.getTime());

  if (spans.length < 2) {
    return unknown('overlap', 'Fewer than two of these state both a time and a length, so nothing can be compared.');
  }

  for (let i = 1; i < spans.length; i += 1) {
    const before = spans[i - 1];
    const after = spans[i];
    if (after.start < before.end) {
      return breaks('overlap',
        `${before.leg.title} is still going at ${clockLabel(before.end)} when ${after.leg.title} starts at ${clockLabel(after.start)}.`,
        [before.leg.itemId, after.leg.itemId]);
    }
  }

  const unmeasured = legs.length - spans.length;
  if (unmeasured > 0) {
    return unknown('overlap',
      `The ones with both a time and a length do not clash, but ${unmeasured} of these state neither.`,
      legs.filter((leg) => endOf(leg) === null).map((leg) => leg.itemId));
  }
  return fits('overlap', 'Nothing here runs into anything else.');
}

/**
 * Enough time to physically get from each leg to the next.
 *
 * The journeys measured are the ones the Plan states, in the sequence it
 * states them. Re-sorting by start time would measure a different evening
 * from the one the guest arranged: a Plan that says the room first and the
 * table second, with times that run the other way, is a contradiction the
 * guest needs told about, and sorting it into chronological order hides
 * exactly that by answering a question nobody asked.
 */
function checkTravel(legs: readonly PlanLeg[]): CheckResult {
  const ordered = legs.filter((leg) => leg.startsAt && placed(leg));

  if (ordered.length < 2) {
    return unknown('travel', 'Fewer than two of these state both a place and a time, so no journey can be measured.');
  }

  let compared = 0;
  for (let i = 1; i < ordered.length; i += 1) {
    const from = ordered[i - 1];
    const to = ordered[i];
    // Leaving time is the end of the previous leg where it has one; otherwise
    // its start, which assumes the group leaves the instant they arrive. That
    // is the most generous reading, and generosity is right here: it can only
    // ever reduce the number of Plans called impossible.
    const leaveAt = endOf(from) ?? from.startsAt!;
    const availableMins = (to.startsAt!.getTime() - leaveAt.getTime()) / 60_000;
    // Negative time is the sequence contradicting itself: the next leg starts
    // before this one is done. Reported plainly rather than as a distance the
    // group could not have covered anyway.
    if (availableMins < 0) {
      return breaks('travel',
        `${to.title} starts before ${from.title} is over, but it comes after it in this Plan.`,
        [from.itemId, to.itemId]);
    }
    const metres = distanceMeters(
      { lat: from.latitude!, lng: from.longitude! },
      { lat: to.latitude!, lng: to.longitude! },
    );
    const neededMins = metres / OPTIMISTIC_TRAVEL_METERS_PER_MIN;
    compared += 1;
    if (availableMins < neededMins) {
      const miles = (metres / 1609.344).toFixed(1);
      return breaks('travel',
        `${miles} miles between ${from.title} and ${to.title}, with ${Math.max(0, Math.round(availableMins))} minutes to cover it.`,
        [from.itemId, to.itemId]);
    }
  }

  const unplaceable = legs.length - ordered.length;
  if (unplaceable > 0) {
    return unknown('travel',
      `The ${compared === 1 ? 'one journey' : `${compared} journeys`} that could be measured leave enough time, but ${unplaceable} of these have no stated place or time.`,
      legs.filter((leg) => !leg.startsAt || !placed(leg)).map((leg) => leg.itemId));
  }
  return fits('travel', 'There is time to get between all of these.');
}

/** The whole Plan against the ceiling the group named. */
function checkBudget(legs: readonly PlanLeg[], plan: PlanConstraints): CheckResult {
  if (plan.budgetCents === null) {
    return unknown('budget', 'No budget was set for this Plan, so there is nothing to check against.');
  }
  if (!plan.partySize || plan.partySize < 1) {
    // Prices are per person. Without a head count the total is unknowable, and
    // quietly pricing it for one would understate it for everyone else.
    return unknown('budget', 'No party size was set, so a per-person price cannot be totalled.');
  }

  const priced = legs.filter((leg) => leg.priceCents !== null);
  if (priced.length === 0) {
    return unknown('budget', 'None of these state a price, so nothing can be totalled.');
  }

  const total = priced.reduce((sum, leg) => sum + leg.priceCents! * plan.partySize!, 0);
  const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;

  if (total > plan.budgetCents) {
    return breaks('budget',
      `${money(total)} for ${plan.partySize} is over the ${money(plan.budgetCents)} you set.`,
      priced.map((leg) => leg.itemId));
  }

  const unpriced = legs.length - priced.length;
  if (unpriced > 0) {
    // The known total fitting is not the Plan fitting. An unpriced leg can take
    // it over on its own, so this stays unknown however much room is left.
    return unknown('budget',
      `${money(total)} so far against ${money(plan.budgetCents)}, but ${unpriced} of these have no stated price.`,
      legs.filter((leg) => leg.priceCents === null).map((leg) => leg.itemId));
  }
  return fits('budget', `${money(total)} for ${plan.partySize} is within the ${money(plan.budgetCents)} you set.`);
}

/** Room for everyone coming. */
function checkCapacity(legs: readonly PlanLeg[], plan: PlanConstraints): CheckResult {
  if (!plan.partySize || plan.partySize < 1) {
    return unknown('capacity', 'No party size was set, so there is nothing to seat.');
  }
  const seated = legs.filter((leg) => leg.seats !== null);
  if (seated.length === 0) {
    return unknown('capacity', 'None of these count seats, so there is nothing to check.');
  }

  const tooSmall = seated.filter((leg) => leg.seats! < plan.partySize!);
  if (tooSmall.length > 0) {
    const names = tooSmall.map((leg) => `${leg.title} (${leg.seats} left)`).join(', ');
    return breaks('capacity', `${names} cannot take ${plan.partySize}.`,
      tooSmall.map((leg) => leg.itemId));
  }

  const uncounted = legs.length - seated.length;
  if (uncounted > 0) {
    return unknown('capacity',
      `The ones that count seats can take ${plan.partySize}, but ${uncounted} of these do not.`,
      legs.filter((leg) => leg.seats === null).map((leg) => leg.itemId));
  }
  return fits('capacity', `Everything here can take ${plan.partySize}.`);
}

/** Roll the five checks into one answer. */
export function planFeasibility(legs: readonly PlanLeg[], plan: PlanConstraints): PlanFeasibility {
  if (legs.length === 0) {
    // An empty Plan is not a working Plan. There is simply nothing to judge,
    // and saying it fits would be an endorsement of nothing.
    const empty = (check: CheckName) => unknown(check, 'This Plan has nothing in it yet.');
    return {
      verdict: 'unknown',
      checks: [empty('window'), empty('overlap'), empty('travel'), empty('budget'), empty('capacity')],
    };
  }

  const checks = [
    checkWindow(legs, plan),
    checkOverlap(legs),
    checkTravel(legs),
    checkBudget(legs, plan),
    checkCapacity(legs, plan),
  ];

  const verdict: Verdict = checks.some((result) => result.verdict === 'breaks') ? 'breaks'
    : checks.some((result) => result.verdict === 'unknown') ? 'unknown'
      : 'fits';

  return { verdict, checks };
}
