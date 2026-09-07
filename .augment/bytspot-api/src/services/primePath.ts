// Prime Path v0 (Phase 5, B4). The rules-only ranker from the contract §5:
// lexicographic hard-filters-then-sort, no weights — an eight-signal weighted
// sum with no completions to fit it to is unfalsifiable, so weights wait until
// there are outcomes (§5.2). This module is pure: candidates are supply facts,
// decoupled from persistence, so the adapter layer (§7) feeds it and it never
// reaches into a table.
//
// Three commitments it enforces in code (§11):
//   1. Never for sale — no commercial term is an input, so none can score.
//   2. A deep link is never Prime Path — Mode A is alternates-only (§3.3, §8.2).
//   3. Own inventory is permanently advantaged — it is the only supply that
//      closes the Booking → Pass → outcome loop (§3.1).

import type { BookableCapability } from './bookableProjection';

/**
 * A supply option for one need, reduced to the facts the rules read. Nothing
 * commercial appears here by construction (commitment 1). `capability` folds
 * the client-only `redirect` into `details`, matching the server projection.
 */
export interface PrimePathCandidate {
  id: string;
  label: string;
  capability: BookableCapability;
  // Native host supply that settles and verifies; a rented/redirect option is
  // false. The single structural advantage the contract states publicly.
  ownInventory: boolean;
  // Capacity this path can seat and the floor it needs to run at all. A group
  // table with a minimum encodes the quorum trap: it "only works if N accept".
  seats: number;
  // B4c: true for parties surfaced via the discovery pool rather than attached
  // to the Plan. The ranker treats them identically; the client shows a
  // "Suggestion" badge and an "Add to Plan" action.
  discovered?: boolean;
  minParty: number;
  // Confirmable in the Plan window for the party — the first hard filter.
  confirmableNow: boolean;
  // Sort inputs, all non-commercial. `travelMinutes` null means unknown, which
  // sorts after any known travel rather than pretending to be near.
  travelMinutes: number | null;
  reliability: number;
  continuationValue: number;
  // Optional facts for the disclosure line; omitted ones drop from the reason.
  startLabel?: string | null;
}

export interface PlanWindowContext {
  // The party the path must seat (confirmability), and the count already
  // committed (quorum viability): a path that needs more than have committed
  // "only works if 2 of 6 accept" and is never featured (§5.2).
  partySize: number;
  goingCount: number;
}

export interface RankedPrimePath {
  prime: PrimePathCandidate | null;
  alternates: PrimePathCandidate[];
  // The mandatory one-line disclosure for the prime pick (§5.3). Null whenever
  // nothing is featured — including when the reason cannot be written, which is
  // itself the signal not to feature.
  reason: string | null;
}

function isModeB(candidate: PrimePathCandidate): boolean {
  return candidate.capability === 'book' || candidate.capability === 'request';
}

/**
 * Hard filters (§5.2): confirmable for this party in this window, and viable
 * for the committed quorum. Everything else is dropped — not demoted — so a
 * path Bytspot cannot actually confirm never appears, as prime or alternate.
 */
function isViable(candidate: PrimePathCandidate, ctx: PlanWindowContext): boolean {
  if (!candidate.confirmableNow) return false;
  if (candidate.seats < ctx.partySize) return false;
  if (candidate.minParty > ctx.goingCount) return false;
  return true;
}

function compareTravel(a: number | null, b: number | null): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a - b;
}

/**
 * Lexicographic order (§5.2, step 3), each tier decided before the next is
 * consulted. Mode B leads so a deep link can never sort into the prime slot;
 * own inventory leads next because it is the only loop-closing supply.
 */
function comparePrimePath(a: PrimePathCandidate, b: PrimePathCandidate): number {
  const modeRank = (c: PrimePathCandidate) => (isModeB(c) ? 0 : 1);
  if (modeRank(a) !== modeRank(b)) return modeRank(a) - modeRank(b);
  if (a.ownInventory !== b.ownInventory) return a.ownInventory ? -1 : 1;
  const travel = compareTravel(a.travelMinutes, b.travelMinutes);
  if (travel !== 0) return travel;
  if (a.reliability !== b.reliability) return b.reliability - a.reliability;
  if (a.continuationValue !== b.continuationValue) return b.continuationValue - a.continuationValue;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * The disclosure line (§5.3). Self-limiting: if the reason cannot be written,
 * the caller does not feature the path. A viable candidate always carries the
 * fits-count and confirmable-now facts, so a Mode B prime always has a line;
 * travel and time are added only when known.
 */
export function primePathReason(candidate: PrimePathCandidate, ctx: PlanWindowContext): string | null {
  if (!isModeB(candidate)) return null;
  const fits = candidate.startLabel ? `fits ${ctx.partySize} at ${candidate.startLabel}` : `fits ${ctx.partySize}`;
  const parts = [fits];
  if (candidate.travelMinutes !== null) parts.push(`${candidate.travelMinutes} min away`);
  parts.push('confirmable now');
  return `★ Prime Path — ${parts.join(', ')}`;
}

/**
 * Rank supply for one need. Returns the single defaulted path, the ordered
 * alternates a decline auto-promotes into (§5.4), and the prime's disclosure
 * line. Prime is null when no confirmable Mode B path exists — a deep-link-only
 * need is honestly alternates-only, never a featured Book.
 */
export function rankPrimePath(candidates: PrimePathCandidate[], ctx: PlanWindowContext): RankedPrimePath {
  const viable = candidates.filter((candidate) => isViable(candidate, ctx)).sort(comparePrimePath);
  if (viable.length === 0) return { prime: null, alternates: [], reason: null };

  const top = viable[0];
  // Mode B leads the sort, so a non-Mode-B top means no featureable path exists.
  if (!isModeB(top)) return { prime: null, alternates: viable, reason: null };

  const reason = primePathReason(top, ctx);
  if (reason === null) return { prime: null, alternates: viable, reason: null };

  return { prime: top, alternates: viable.slice(1), reason };
}
