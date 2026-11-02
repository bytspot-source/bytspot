/**
 * Pluggable per-need ranker. The engine stays backend-agnostic: bytspot-api
 * plugs in Prime Path (backend/primePath.ts); without a ranker the model's
 * selection is used (v1 behavior).
 *
 * The engine hands the ranker facts only — candidates from the ledger, their
 * Bytspot bookables / table links, and travel from the previous stop when the
 * routing port gave an estimate. The ranker decides; the model cannot.
 */
import type { Candidate } from './skills/discovery';
import type { BookingOption } from './types';

export type BytspotOption = Extract<BookingOption, { kind: 'bytspot' }>;
export type DeeplinkOption = Extract<BookingOption, { kind: 'deeplink' }>;

export interface RankableOption {
  candidate: Candidate;
  /** Bytspot bookables at the place (bookables skill; `details` rows already removed). */
  bytspot: BytspotOption[];
  /** OpenTable/Resy hand-off links. Never imply availability. */
  deeplinks: DeeplinkOption[];
  /** From the routing port's estimate when known; null = unknown (never 0). */
  travelMinutes: number | null;
}

export interface NeedRankingInput {
  need: string;
  options: RankableOption[];
  partySize: number;
  /** People already committed. For an unsaved proposal only the requester (1). */
  goingCount: number;
  window: { startsAt: string | null; endsAt: string | null };
}

export type DropReason = 'not_confirmable' | 'seats' | 'min_party';

export interface NeedRanking {
  primeId: string | null;
  /** The ranker's disclosure line for the prime; null when nothing is featured. */
  reason: string | null;
  /** Viable ranked alternates, in decline auto-promotion order. */
  rankedAlternateIds: string[];
  /** Options the ranker cannot vouch for (deep links / details): listed after, never prime. */
  unrankedIds: string[];
  /** Ranked supply that failed a hard filter — never shown, prime or alternate. */
  dropped: Array<{ id: string; why: DropReason }>;
}

export interface NeedRanker {
  name: 'prime_path' | string;
  rank(input: NeedRankingInput): NeedRanking;
}
