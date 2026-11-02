/**
 * Guards on model-written text. Facts (crowd labels, prices, links) are
 * generated in code; free text from the model is checked and replaced with a
 * deterministic summary when it breaks a rule.
 */

const LIVE_CLAIM = /\b(live|real[- ]?time)\b|\b(right now|currently|at the moment)\b[^.]*\b(busy|packed|quiet|chill|crowd|crowded|line|empty|dead)\b|\b(busy|packed|quiet|crowded|empty)\b[^.]*\b(right now|at the moment)\b/i;
const AVAILABILITY_CLAIM = /\b(table|tables|seats?|spots?) (is |are )?(open|available|free)\b|\b(i|we)('ve| have)? (booked|reserved)\b|\bconfirmed\b/i;
const DOLLARS = /\$\s?(\d+(?:\.\d{1,2})?)/g;

export interface HonestyFacts {
  /** Names of places whose crowd reading is genuinely live (live source + time). */
  liveNames: string[];
  /** Names of every other place in play (typical or no crowd data). */
  otherNames: string[];
  /** Dollar amounts (in cents) the text may mention: computed prices, totals, budget. */
  allowedCents: number[];
}

export function honestyViolations(text: string, facts: HonestyFacts): string[] {
  const problems: string[] = [];
  if (LIVE_CLAIM.test(text)) {
    // A live claim is allowed only about places with live data, and never about a typical one.
    const lower = text.toLowerCase();
    const namesLive = facts.liveNames.some((n) => lower.includes(n.toLowerCase()));
    const namesOther = facts.otherNames.some((n) => lower.includes(n.toLowerCase()));
    if (!facts.liveNames.length || namesOther || !namesLive) problems.push('live_claim');
  }
  if (AVAILABILITY_CLAIM.test(text)) problems.push('availability_claim');
  for (const match of text.matchAll(DOLLARS)) {
    const cents = Math.round(Number(match[1]) * 100);
    if (!facts.allowedCents.some((a) => Math.abs(a - cents) <= 100)) { problems.push('unverified_price'); break; }
  }
  return problems;
}
