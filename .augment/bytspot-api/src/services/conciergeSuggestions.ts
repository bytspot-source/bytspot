import { rankPrimePath, type PrimePathCandidate } from './primePath';
import { categoryForParty } from '../trpc/planRouter';
import { eventsRouter } from '../trpc/eventsRouter';
import { db } from '../lib/db';
import { withDeadline } from './conciergeDiscovery';
import { typicalCrowd } from './typicalOccupancy';
import type { Context } from '../trpc/context';
import {
  SuggestionEngine, type SuggestionPorts, type SuggestionRequest, type UpcomingPlanFact,
} from '../bytt-si/suggestions';
import type { LLMProvider } from '../bytt-si/llm';
import { SUGGESTION_NEEDS, type SuggestionNeed } from '../bytt-si/suggestions/types';

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const PRIME_PATH_TIMEOUT_MS = 1_500;

export interface NearbyPartyForPrimePath {
  capability: 'book' | 'request' | 'details';
  spacesRemaining: number;
  hostCategory: string | null;
  hostType: string | null;
  startsAt: string;
  endsAt: string | null;
}

export interface PlanWindow { startsAt: Date; endsAt: Date }

/** Tonight in Atlanta: now through 5 AM if the night has started, otherwise 5 PM–5 AM. */
export function tonightWindow(now: Date): PlanWindow {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23',
  }).formatToParts(now).map((part) => [part.type, part.value]));
  const offset = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', timeZoneName: 'longOffset' })
    .formatToParts(now).find((part) => part.type === 'timeZoneName')?.value.match(/GMT([+-]\d{2}:\d{2})/)?.[1] ?? '-05:00';
  let hour = Number(parts.hour);
  if (hour === 24) hour = 0;
  const endDay = hour < 5
    ? `${parts.year}-${parts.month}-${parts.day}`
    : new Date(Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day) + 1)).toISOString().slice(0, 10);
  const endsAt = new Date(`${endDay}T05:00:00${offset}`);
  const startsAt = hour >= 17 || hour < 5 ? now : new Date(`${parts.year}-${parts.month}-${parts.day}T17:00:00${offset}`);
  return { startsAt, endsAt };
}

function overlapsWindow(party: NearbyPartyForPrimePath, window: PlanWindow): boolean {
  const start = new Date(party.startsAt);
  if (Number.isNaN(start.getTime())) return false;
  const end = party.endsAt ? new Date(party.endsAt) : new Date(start.getTime() + 6 * 60 * 60 * 1000);
  if (Number.isNaN(end.getTime())) return false;
  return start < window.endsAt && end > window.startsAt;
}

/**
 * Which suggestion needs Prime Path can feature from parties already returned
 * to this guest. Details-only and full parties are not featured. A party outside
 * `window` (tonight, for these chips) is not confirmable. Travel time is left unknown.
 */
export function confirmableNeedsFromParties(parties: NearbyPartyForPrimePath[], window: PlanWindow): SuggestionNeed[] {
  const byNeed = new Map<SuggestionNeed, PrimePathCandidate[]>();
  parties.forEach((party, index) => {
    const category = categoryForParty({ hostCategory: party.hostCategory, hostType: party.hostType });
    if (!(SUGGESTION_NEEDS as readonly string[]).includes(category)) return;
    const need = category as SuggestionNeed;
    const seats = Math.max(0, Math.trunc(party.spacesRemaining));
    const candidate: PrimePathCandidate = {
      id: `party-${index}`, label: need, capability: party.capability, ownInventory: true,
      seats, minParty: 1, confirmableNow: seats > 0 && overlapsWindow(party, window),
      travelMinutes: null, reliability: 0, continuationValue: 0,
    };
    byNeed.set(need, [...(byNeed.get(need) ?? []), candidate]);
  });
  const found: SuggestionNeed[] = [];
  for (const need of SUGGESTION_NEEDS) {
    const ranked = rankPrimePath(byNeed.get(need) ?? [], { partySize: 1, goingCount: 1 });
    if (ranked.prime) found.push(need);
  }
  return found;
}

/** Real Plans and typical curves for one signed-in guest. Failures become empty or unavailable. */
export function createSuggestionPorts(ctx: Context): SuggestionPorts {
  return {
    async upcomingPlans(userId, now) {
      const rows = await db.plan.findMany({
        where: {
          creatorUserId: userId, deletedAt: null, cancelledAt: null,
          OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
          AND: [{ OR: [
            { startsAt: { gte: now } },
            { startsAt: null, createdAt: { gte: new Date(now.getTime() - WEEK_MS) } },
          ] }],
        },
        select: { id: true, title: true, startsAt: true, areaLabel: true },
        orderBy: [{ startsAt: 'asc' }, { createdAt: 'desc' }],
        take: 5,
      });
      const plans: UpcomingPlanFact[] = rows.map((row) => ({
        id: row.id, title: row.title, startsAt: row.startsAt?.toISOString() ?? null, areaLabel: row.areaLabel,
      }));
      return plans;
    },
    async recentNeeds(userId) {
      const rows = await db.plan.findMany({
        where: { creatorUserId: userId, deletedAt: null },
        select: { needs: true },
        orderBy: { createdAt: 'desc' },
        take: 8,
      });
      return rows.flatMap((row) => row.needs);
    },
    async typical({ hour, dayOfWeek, category }) {
      const crowd = typicalCrowd(hour, dayOfWeek, category);
      return { level: crowd.level, label: crowd.label };
    },
    async primePath({ latitude, longitude, now }) {
      if (latitude === null || longitude === null || !ctx.user) return { status: 'unavailable', confirmableNeeds: [] };
      const { parties } = await withDeadline(
        eventsRouter.createCaller(ctx).nearby({ lat: latitude, lng: longitude, radiusMiles: 3, limit: 20 }),
        PRIME_PATH_TIMEOUT_MS,
      );
      const clock = new Date(now);
      return {
        status: 'ok',
        confirmableNeeds: confirmableNeedsFromParties(parties.map((party) => ({
          capability: party.capability, spacesRemaining: party.spacesRemaining,
          hostCategory: party.hostCategory, hostType: party.hostType,
          startsAt: party.startsAt, endsAt: party.endsAt,
        })), tonightWindow(Number.isNaN(clock.getTime()) ? new Date() : clock)),
      };
    },
  };
}

export function suggestForGuest(request: SuggestionRequest, ports: SuggestionPorts, llm: LLMProvider | null) {
  return new SuggestionEngine({ llm, ports, deadlineMs: 2_000 }).suggest(request);
}
