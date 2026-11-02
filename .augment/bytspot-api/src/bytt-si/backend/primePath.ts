/**
 * Prime Path adapter for BYTT-SI. Maps BYTT-SI candidates to the existing,
 * unchanged ranker in services/primePath.ts and returns its decision.
 *
 * Honest mapping (nothing is asserted that the data does not state):
 * - Bytspot parties (`party:<id>` events with capability book/request) and
 *   places with a Bytspot bookable are own inventory. Party capability comes
 *   from the server projection (bookableProjection.capabilityForAccessMode,
 *   applied by eventsRouter.nearby); seats are live `spacesRemaining`, never a
 *   Typical crowd figure. Unknown seats are 0 and not confirmable.
 * - OpenTable/Resy links, Google places and Ticketmaster events are details /
 *   deep links. Bytspot can't confirm them and has no seat count, so they are
 *   NOT fed to rankPrimePath (doing so would mean inventing confirmableNow and
 *   seats). They are listed after the ranked alternates, never as prime.
 * - travelMinutes is the routing estimate when known, else null.
 * - reliability and continuationValue are neutral (0) — no outcome data yet.
 * - Nothing commercial (price, fees, sponsorship) is an input.
 */
import { rankPrimePath, type PrimePathCandidate } from '../../services/primePath';
import { clockLabel } from '../core/time';
import type { DropReason, NeedRanker, NeedRanking, NeedRankingInput, RankableOption } from '../ranking';

export type { RankableOption };

const NEUTRAL = { reliability: 0, continuationValue: 0 } as const;
const isModeB = (capability: string): capability is 'book' | 'request' => capability === 'book' || capability === 'request';

function inWindow(startsAt: string | null, endsAt: string | null, window: NeedRankingInput['window']): boolean {
  if (!startsAt) return true;
  const start = new Date(startsAt).getTime();
  const end = endsAt ? new Date(endsAt).getTime() : start;
  if (window.endsAt && start >= new Date(window.endsAt).getTime()) return false;
  if (window.startsAt && end <= new Date(window.startsAt).getTime()) return false;
  return true;
}

/** Null = not native Bytspot supply, so Prime Path cannot rank it (alternates only). */
export function primePathCandidateFor(option: RankableOption, window: NeedRankingInput['window']): PrimePathCandidate | null {
  const c = option.candidate;
  if (c.kind === 'event') {
    if (!c.bookableId?.startsWith('party:') || !isModeB(c.capability)) return null;
    const seats = c.capacity ?? 0;
    return {
      id: c.id, label: c.name, capability: c.capability, ownInventory: true,
      seats, minParty: c.minParty ?? 1,
      confirmableNow: c.capacity !== null && seats > 0 && inWindow(c.startsAt, c.endsAt, window),
      travelMinutes: option.travelMinutes, ...NEUTRAL, startLabel: c.startsAt ? clockLabel(c.startsAt) : null,
    };
  }
  const own = option.bytspot.filter((b) => isModeB(b.capability)).sort((a, b) => (b.capacity ?? 0) - (a.capacity ?? 0));
  const best = own[0];
  if (!best) return null;
  const seats = best.capacity ?? 0;
  return {
    id: c.id, label: c.name, capability: best.capability as 'book' | 'request', ownInventory: true,
    seats, minParty: 1, confirmableNow: seats > 0,
    travelMinutes: option.travelMinutes, ...NEUTRAL, startLabel: null,
  };
}

const travelOrder = (a: RankableOption, b: RankableOption) => {
  if (a.travelMinutes !== b.travelMinutes) {
    if (a.travelMinutes === null) return 1;
    if (b.travelMinutes === null) return -1;
    return a.travelMinutes - b.travelMinutes;
  }
  return a.candidate.id < b.candidate.id ? -1 : a.candidate.id > b.candidate.id ? 1 : 0;
};

/** Why a ranked candidate was dropped — for the guest-facing notice only; membership comes from rankPrimePath. */
function dropReason(c: PrimePathCandidate, ctx: { partySize: number; goingCount: number }): DropReason {
  if (!c.confirmableNow) return 'not_confirmable';
  if (c.seats < ctx.partySize) return 'seats';
  return 'min_party';
}

export const primePathNeedRanker: NeedRanker = {
  name: 'prime_path',
  rank(input: NeedRankingInput): NeedRanking {
    const ctx = { partySize: Math.max(1, input.partySize), goingCount: Math.max(1, input.goingCount) };
    const mapped = input.options.map((option) => ({ option, supply: primePathCandidateFor(option, input.window) }));
    const supply = mapped.flatMap((m) => (m.supply ? [m.supply] : []));
    const ranked = rankPrimePath(supply, ctx);
    const kept = new Set([ranked.prime?.id, ...ranked.alternates.map((a) => a.id)]);
    return {
      primeId: ranked.prime?.id ?? null,
      reason: ranked.reason,
      rankedAlternateIds: ranked.alternates.map((a) => a.id),
      unrankedIds: mapped.filter((m) => !m.supply).map((m) => m.option).sort(travelOrder).map((o) => o.candidate.id),
      dropped: supply.filter((c) => !kept.has(c.id)).map((c) => ({ id: c.id, why: dropReason(c, ctx) })),
    };
  },
};
