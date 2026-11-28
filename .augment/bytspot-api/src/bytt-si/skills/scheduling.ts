import { z } from 'zod';
import { guestTravelLine, knownDriveMinutes, TRAVEL_TIME_UNAVAILABLE } from '../../services/travelCopy';
import { estimateTravel } from '../core/geo';
import { DEFAULT_DURATION_MINS, overallVerdict, scheduleChecks, scheduleStops } from '../core/schedule';
import type { Ports } from '../ports/types';
import { defineSkill, isoDateTime } from './types';

const input = z.object({
  startsAt: isoDateTime.optional().describe('Window start; defaults to the request.'),
  endsAt: isoDateTime.optional(),
  stops: z.array(z.object({
    id: z.string(), title: z.string(), needKind: z.string().optional(),
    latitude: z.number(), longitude: z.number(),
    durationMins: z.number().int().min(5).max(600).optional(),
    fixedStartsAt: isoDateTime.optional().describe('Only for stops whose start is stated by the supply (events).'),
    driveMinutes: z.number().int().min(0).max(180).optional().describe('MapKit drive minutes from the previous stop, already measured on the guest\'s phone. Omit when unknown. Do not guess.'),
  })).min(1).max(8),
});
const output = z.object({
  verdict: z.enum(['fits', 'breaks', 'unknown']),
  stops: z.array(z.object({
    id: z.string(), title: z.string(), startsAt: z.string().nullable(), endsAt: z.string().nullable(),
    durationMins: z.number().nullable(), travelMinsBefore: z.number().nullable(),
    travelLine: z.string().nullable(),
    timeSource: z.enum(['fixed', 'scheduled', 'model']),
  })),
  checks: z.array(z.object({ check: z.enum(['window', 'overlap', 'travel', 'budget', 'capacity']), verdict: z.enum(['fits', 'breaks', 'unknown']), detail: z.string() })),
});

export interface LegTravel {
  /** Minutes used to place the next stop. A guest is not shown this on its own. */
  spacingMinutes: number | null;
  /** Minutes a guest may be shown. Null when travel time is unavailable. */
  statedMinutes: number | null;
  line: string | null;
}

const NO_LEG: LegTravel = { spacingMinutes: null, statedMinutes: null, line: null };

function published(minutes: number, basis: 'provider' | 'estimate'): LegTravel {
  const line = basis === 'estimate' ? guestTravelLine(minutes, 'estimate') : `${minutes} min`;
  return { spacingMinutes: minutes, statedMinutes: minutes, line };
}

function mapkitLeg(minutes: number): LegTravel {
  return { spacingMinutes: minutes, statedMinutes: minutes, line: guestTravelLine(minutes, 'apple_maps') };
}

/**
 * Travel before each stop (index 0 is empty). A MapKit `driveMinutes` is what
 * the guest is told and how that hop is placed. Otherwise the routing port's
 * minutes are used. If the port fails, stop placement may still use the
 * straight-line estimate so the evening does not collapse, but the guest is
 * told travel time is unavailable and no guessed duration is published.
 */
export async function travelBetween(ports: Ports, stops: ReadonlyArray<{ latitude: number; longitude: number; driveMinutes?: number | null }>): Promise<LegTravel[]> {
  const out: LegTravel[] = [NO_LEG];
  for (let i = 1; i < stops.length; i += 1) {
    const fallback = estimateTravel(stops[i - 1], stops[i]);
    const mapkit = knownDriveMinutes(stops[i].driveMinutes);
    try {
      const est = await ports.routing.travel(stops[i - 1], stops[i], fallback.mode);
      if (mapkit !== null) { out.push(mapkitLeg(mapkit)); continue; }
      out.push(est ? published(est.minutes, est.basis) : { spacingMinutes: fallback.minutes, statedMinutes: null, line: TRAVEL_TIME_UNAVAILABLE });
    } catch {
      out.push(mapkit !== null ? mapkitLeg(mapkit) : { spacingMinutes: fallback.minutes, statedMinutes: null, line: TRAVEL_TIME_UNAVAILABLE });
    }
  }
  return out;
}

export const schedulingSkill = defineSkill({
  name: 'scheduling',
  description: 'Order stops inside the time window with travel between them. Returns start/end per stop and window/overlap/travel checks (fits / breaks / unknown). A straight-line hop is "about N min (estimate)". driveMinutes on a stop is a MapKit drive and is labeled "Apple Maps estimate". If routing fails and no MapKit time was given, say travel time is unavailable and do not invent a duration.',
  input, output,
  async run(args, { ports, defaults }) {
    const window = { startsAt: args.startsAt ?? defaults.startsAt, endsAt: args.endsAt ?? defaults.endsAt };
    const legs = await travelBetween(ports, args.stops);
    const spaced = scheduleStops(window, args.stops.map((s) => ({
      id: s.id, title: s.title, fixedStartsAt: s.fixedStartsAt ?? null,
      durationMins: s.durationMins ?? DEFAULT_DURATION_MINS[s.needKind ?? ''] ?? 90,
    })), legs.map((leg) => leg.spacingMinutes));
    const stops = spaced.map((stop, i) => ({
      ...stop,
      travelMinsBefore: legs[i]?.statedMinutes ?? null,
      travelLine: legs[i]?.line ?? null,
    }));
    const checks = scheduleChecks(window, stops);
    return { verdict: overallVerdict(checks), stops, checks };
  },
});
