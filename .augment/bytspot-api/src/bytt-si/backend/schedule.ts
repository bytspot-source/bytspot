import { buildItinerary, type ItineraryStopInput, type OpeningPeriod } from '../../services/itinerary';
import type { HostScheduledStop, ScheduleRequest } from '../engine';

/**
 * Scheduler over services/itinerary (the plans.itinerary timeline), so a
 * proposal and a saved Plan are timed the same way: the Quick check's 45 mph
 * travel floor plus a buffer between stops, typical lengths where the supply
 * states none, and Google opening hours when they are known.
 */
export interface SchedulerDeps {
  /** Google opening hours for a place; null when unknown. */
  hoursFor(placeId: string): Promise<OpeningPeriod[] | null>;
}

/** BYTT-SI need kinds that are named differently on the Plan timeline. */
const TIMELINE_KIND: Record<string, string> = { event: 'events' };

const HOURS_ISSUE = /^(Closed|Closes) at /;

export function createBackendScheduler(deps: SchedulerDeps) {
  return async (request: ScheduleRequest): Promise<HostScheduledStop[]> => {
    const hours = await Promise.all(request.stops.map((stop) => (stop.placeId ? deps.hoursFor(stop.placeId).catch(() => null) : Promise.resolve(null))));
    const inputs: ItineraryStopInput[] = request.stops.map((stop, index) => ({
      leg: {
        itemId: stop.id, position: index, needKind: TIMELINE_KIND[stop.needKind] ?? stop.needKind, title: stop.title,
        startsAt: stop.fixedStartsAt ? new Date(stop.fixedStartsAt) : null, durationMins: stop.durationMins,
        latitude: stop.latitude, longitude: stop.longitude, priceCents: null, seats: null,
      },
      timeSource: stop.fixedStartsAt ? stop.fixedBy ?? 'event' : null,
      hours: hours[index],
    }));
    const itinerary = buildItinerary(inputs, {
      startsAt: request.window.startsAt ? new Date(request.window.startsAt) : null,
      endsAt: request.window.endsAt ? new Date(request.window.endsAt) : null,
    });
    const byId = new Map(itinerary.stops.map((stop) => [stop.itemId, stop]));
    return request.stops.map((stop, index) => {
      const timed = byId.get(stop.id);
      if (!timed) throw new Error(`timeline skipped ${stop.id}`);
      const hoursIssue = timed.issues.find((issue) => HOURS_ISSUE.test(issue)) ?? null;
      return {
        id: stop.id,
        startsAt: timed.arriveAt?.toISOString() ?? null,
        endsAt: timed.leaveAt?.toISOString() ?? null,
        durationMins: timed.lengthMins,
        travelMinsBefore: index === 0 ? null : timed.travel?.atLeastMins ?? null,
        fixed: timed.time === 'set',
        hoursIssue,
        closed: hoursIssue?.startsWith('Closed at ') ?? false,
      };
    });
  };
}
