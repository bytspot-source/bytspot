import { z } from 'zod';
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
  })).min(1).max(8),
});
const output = z.object({
  verdict: z.enum(['fits', 'breaks', 'unknown']),
  stops: z.array(z.object({
    id: z.string(), title: z.string(), startsAt: z.string().nullable(), endsAt: z.string().nullable(),
    durationMins: z.number().nullable(), travelMinsBefore: z.number().nullable(), timeSource: z.enum(['fixed', 'scheduled', 'model']),
  })),
  checks: z.array(z.object({ check: z.enum(['window', 'overlap', 'travel', 'budget', 'capacity']), verdict: z.enum(['fits', 'breaks', 'unknown']), detail: z.string() })),
});

/** Travel minutes before each stop (index 0 = null). Routing port first, straight-line estimate if it fails. */
export async function travelBetween(ports: Ports, stops: ReadonlyArray<{ latitude: number; longitude: number }>): Promise<(number | null)[]> {
  const out: (number | null)[] = [null];
  for (let i = 1; i < stops.length; i += 1) {
    const fallback = estimateTravel(stops[i - 1], stops[i]);
    try {
      const est = await ports.routing.travel(stops[i - 1], stops[i], fallback.mode);
      out.push(est ? est.minutes : fallback.minutes);
    } catch { out.push(fallback.minutes); }
  }
  return out;
}

export const schedulingSkill = defineSkill({
  name: 'scheduling',
  description: 'Order stops inside the time window with travel between them. Returns start/end per stop and window/overlap/travel checks (fits / breaks / unknown).',
  input, output,
  async run(args, { ports, defaults }) {
    const window = { startsAt: args.startsAt ?? defaults.startsAt, endsAt: args.endsAt ?? defaults.endsAt };
    const travel = await travelBetween(ports, args.stops);
    const stops = scheduleStops(window, args.stops.map((s) => ({
      id: s.id, title: s.title, fixedStartsAt: s.fixedStartsAt ?? null,
      durationMins: s.durationMins ?? DEFAULT_DURATION_MINS[s.needKind ?? ''] ?? 90,
    })), travel);
    const checks = scheduleChecks(window, stops);
    return { verdict: overallVerdict(checks), stops, checks };
  },
});
