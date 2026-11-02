import type { CheckResult, Verdict } from '../types';
import { addMinutes, clockLabel, roundUpTo5 } from './time';

/** Planning defaults when the supply does not state a length. Marked as suggestions, never as facts. */
export const DEFAULT_DURATION_MINS: Record<string, number> = {
  dining: 90, drinks: 75, nightlife: 120, event: 120, coffee: 45, activity: 90,
};

export interface ScheduleStop {
  id: string;
  title: string;
  durationMins: number | null;
  /** Start the supply states (e.g. an event). Cannot be moved. */
  fixedStartsAt: string | null;
  /** Start the model suggested. Kept only if it passes the checks. */
  preferredStartsAt?: string | null;
}

export interface ScheduledStop {
  id: string;
  title: string;
  startsAt: string | null;
  endsAt: string | null;
  durationMins: number | null;
  travelMinsBefore: number | null;
  timeSource: 'fixed' | 'scheduled' | 'model';
}

const t = (iso: string) => new Date(iso).getTime();

/**
 * Sequential schedule inside the window: each stop starts after the previous
 * one ends plus travel (rounded up to 5 min). Fixed starts are honored and
 * reported if they cannot be reached. Pure: same input, same output.
 */
export function scheduleStops(window: { startsAt: string | null; endsAt: string | null }, stops: readonly ScheduleStop[], travelBefore: readonly (number | null)[]): ScheduledStop[] {
  const out: ScheduledStop[] = [];
  let cursor: string | null = window.startsAt ?? stops.find((s) => s.fixedStartsAt)?.fixedStartsAt ?? stops[0]?.preferredStartsAt ?? null;
  stops.forEach((stop, i) => {
    const travel = i === 0 ? null : travelBefore[i] ?? null;
    const earliest = cursor === null ? null : i === 0 ? cursor : addMinutes(cursor, roundUpTo5(travel ?? 0));
    let startsAt: string | null; let timeSource: ScheduledStop['timeSource'];
    if (stop.fixedStartsAt) { startsAt = stop.fixedStartsAt; timeSource = 'fixed'; }
    else if (stop.preferredStartsAt && earliest && t(stop.preferredStartsAt) >= t(earliest)) { startsAt = stop.preferredStartsAt; timeSource = 'model'; }
    else { startsAt = earliest; timeSource = 'scheduled'; }
    const endsAt = startsAt && stop.durationMins !== null ? addMinutes(startsAt, stop.durationMins) : null;
    out.push({ id: stop.id, title: stop.title, startsAt, endsAt, durationMins: stop.durationMins, travelMinsBefore: travel, timeSource });
    cursor = endsAt;
  });
  return out;
}

/** Window, overlap and travel checks on a schedule. Three-valued, like planFeasibility.ts. */
export function scheduleChecks(window: { startsAt: string | null; endsAt: string | null }, stops: readonly ScheduledStop[]): CheckResult[] {
  const checks: CheckResult[] = [];
  if (!window.startsAt || !window.endsAt) {
    checks.push({ check: 'window', verdict: 'unknown', detail: 'This Plan has no start and end time yet.' });
  } else {
    const outside = stops.filter((s) => s.startsAt && (t(s.startsAt) < t(window.startsAt!) || t(s.startsAt) > t(window.endsAt!) || (s.endsAt && t(s.endsAt) > t(window.endsAt!))));
    const untimed = stops.filter((s) => !s.startsAt);
    checks.push(outside.length
      ? { check: 'window', verdict: 'breaks', detail: `${outside.map((s) => s.title).join(', ')} falls outside ${clockLabel(window.startsAt)}–${clockLabel(window.endsAt)}.` }
      : untimed.length ? { check: 'window', verdict: 'unknown', detail: `${untimed.map((s) => s.title).join(', ')} has no time yet.` }
        : { check: 'window', verdict: 'fits', detail: 'Every stop fits the time window.' });
  }
  let overlap: Verdict = stops.length < 2 ? 'unknown' : 'fits'; let overlapDetail = stops.length < 2 ? 'Only one stop.' : 'No stops overlap.';
  let travel: Verdict = stops.length < 2 ? 'unknown' : 'fits'; let travelDetail = stops.length < 2 ? 'Only one stop.' : 'There is time to get between stops.';
  for (let i = 1; i < stops.length; i += 1) {
    const prev = stops[i - 1]; const cur = stops[i];
    if (!prev.endsAt || !cur.startsAt) { if (overlap === 'fits') { overlap = 'unknown'; overlapDetail = 'Some stops have no time or length.'; } if (travel === 'fits') { travel = 'unknown'; travelDetail = 'Some stops have no time or length.'; } continue; }
    if (t(cur.startsAt) < t(prev.endsAt)) { overlap = 'breaks'; overlapDetail = `${cur.title} starts before ${prev.title} ends.`; continue; }
    if (cur.travelMinsBefore === null) { if (travel === 'fits') { travel = 'unknown'; travelDetail = `No travel estimate to ${cur.title}.`; } continue; }
    if (t(cur.startsAt) < t(prev.endsAt) + cur.travelMinsBefore * 60_000) { travel = 'breaks'; travelDetail = `Not enough time to get from ${prev.title} to ${cur.title}.`; }
  }
  checks.push({ check: 'overlap', verdict: overlap, detail: overlapDetail });
  checks.push({ check: 'travel', verdict: travel, detail: travelDetail });
  return checks;
}

export function capacityCheck(partySize: number | null, seats: readonly { title: string; seats: number | null }[]): CheckResult {
  if (!partySize) return { check: 'capacity', verdict: 'unknown', detail: 'Group size not set.' };
  const short = seats.filter((s) => s.seats !== null && s.seats < partySize);
  if (short.length) return { check: 'capacity', verdict: 'breaks', detail: `${short.map((s) => s.title).join(', ')} can't seat ${partySize}.` };
  if (seats.every((s) => s.seats === null)) return { check: 'capacity', verdict: 'unknown', detail: 'Seat counts are not known for these stops.' };
  return { check: 'capacity', verdict: 'fits', detail: `Seats ${partySize}.` };
}

export function overallVerdict(checks: readonly CheckResult[]): Verdict {
  if (checks.some((c) => c.verdict === 'breaks')) return 'breaks';
  if (checks.some((c) => c.verdict === 'unknown')) return 'unknown';
  return 'fits';
}
