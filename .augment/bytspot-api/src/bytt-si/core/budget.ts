import type { BudgetSummary, PriceBasis } from '../types';
import { money } from './money';

export interface PricedStop { title?: string; priceCents: number | null; priceBasis: PriceBasis | null }

/**
 * Budget check, enforced in code. Same semantics as bytspot-api planFeasibility
 * checkBudget: prices are per person, budgetCents is the group's total ceiling,
 * and unknown never collapses into fits.
 */
export function evaluateBudget(stops: readonly PricedStop[], partySize: number | null, budgetCents: number | null): BudgetSummary {
  const priced = stops.filter((s) => s.priceCents !== null);
  const perPerson = priced.length ? priced.reduce((sum, s) => sum + (s.priceCents as number), 0) : null;
  const total = perPerson !== null && partySize ? perPerson * partySize : null;
  const basis: BudgetSummary['basis'] = priced.length === 0 ? 'unknown'
    : priced.some((s) => s.priceBasis === 'estimate') ? 'estimate' : 'exact';
  const base = { budgetCents, perPersonCents: perPerson, totalCents: total, basis };

  if (budgetCents === null) return { ...base, verdict: 'unknown', detail: 'No budget was set.' };
  if (!partySize) return { ...base, verdict: 'unknown', detail: 'Add your group size to add up the cost.' };
  if (total === null) return { ...base, verdict: 'unknown', detail: 'None of the stops have a price yet.' };
  if (total > budgetCents) {
    return { ...base, verdict: 'breaks', detail: `${money(total)} for ${partySize} is over your ${money(budgetCents)} budget (${money(Math.ceil(budgetCents / partySize))} each).` };
  }
  const unpriced = stops.length - priced.length;
  if (unpriced > 0) {
    return { ...base, verdict: 'unknown', detail: `${money(total)} so far of ${money(budgetCents)}, but ${unpriced} stop(s) have no price yet.` };
  }
  const est = basis === 'estimate' ? ' (estimate)' : '';
  return { ...base, verdict: 'fits', detail: `About ${money(perPerson!)} each, ${money(total)} total for ${partySize}${est} — within ${money(budgetCents)}.` };
}
