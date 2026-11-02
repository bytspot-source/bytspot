import type { PlanLeg } from '../../services/planLegs';
import { planFeasibility } from '../../services/planFeasibility';
import type { ProposedPlan } from '../types';

/** A proposal's stops as the PlanLegs planFeasibility judges. Null stays null: nothing is defaulted. */
export function proposalLegs(plan: ProposedPlan): PlanLeg[] {
  return plan.items.map((item) => ({
    itemId: item.candidateId,
    position: item.position,
    needKind: item.needKind,
    title: item.title,
    startsAt: item.startsAt ? new Date(item.startsAt) : null,
    durationMins: item.durationMins,
    latitude: item.placeLat,
    longitude: item.placeLng,
    priceCents: item.priceCents,
    seats: item.booking.find((b) => b.kind === 'bytspot')?.capacity ?? null,
  }));
}

/**
 * The backend's own verdict (planFeasibility.ts) on a proposal. Wired as the
 * engine's `finalCheck`, so the same checks a saved Plan gets from
 * `plans.feasibility` decide whether the proposal may be booked.
 */
export async function backendFinalCheck(plan: ProposedPlan): Promise<{ verdict: ProposedPlan['feasibility']['verdict']; checks: ProposedPlan['feasibility']['checks'] }> {
  const result = planFeasibility(proposalLegs(plan), {
    startsAt: plan.startsAt ? new Date(plan.startsAt) : null,
    endsAt: plan.endsAt ? new Date(plan.endsAt) : null,
    partySize: plan.partySize,
    budgetCents: plan.budgetCents,
  });
  return { verdict: result.verdict, checks: result.checks.map(({ check, verdict, detail }) => ({ check, verdict, detail })) };
}
