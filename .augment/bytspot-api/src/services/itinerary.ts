import { distanceMeters } from './checkinProof';
import { OPTIMISTIC_TRAVEL_METERS_PER_MIN } from './planFeasibility';
import type { PlanLeg } from './planLegs';

/**
 * A suggested timeline for a Plan: when to arrive at each stop and when to
 * leave, in the order the person chose.
 *
 * Every time is labelled. `set` means a party, a won offer or the guest's own
 * booking states it; `estimated` means this module placed it. Lengths are the
 * same: `stated` by the supply, or `estimated` from a typical length for that
 * kind of stop. Nothing estimated here is ever written back as a fact.
 *
 * Travel uses the Quick check's 45 mph floor, so the server's gaps are a
 * minimum. The phone shows real Apple Maps times between stops.
 *
 * Pure: no clock, no database, no network.
 */

/** Google's `regularOpeningHours.periods`, in the place's local time. Day 0 is Sunday. */
export interface OpeningPeriod {
  open: { day: number; hour: number; minute: number };
  close?: { day: number; hour: number; minute: number } | null;
}

export type TimeSource = 'offer' | 'party' | 'guestBooking';

export interface ItineraryStopInput {
  leg: PlanLeg;
  /** Who stated `leg.startsAt`, or null when nothing did. */
  timeSource: TimeSource | null;
  /** Null when the hours are not known. */
  hours: OpeningPeriod[] | null;
}

export interface ItineraryConstraints {
  startsAt: Date | null;
  endsAt: Date | null;
}

export interface ItineraryStop {
  itemId: string;
  title: string;
  needKind: string;
  arriveAt: Date | null;
  leaveAt: Date | null;
  time: 'set' | 'estimated' | null;
  timeSource: TimeSource | null;
  lengthMins: number;
  length: 'stated' | 'estimated';
  /** From the previous stop. Null for the first stop, or when either end has no place. */
  travel: { meters: number; atLeastMins: number } | null;
  /** Minutes spent waiting for a place to open, or for a set time to come round. */
  waitMins: number;
  hours: 'known' | 'unknown';
  /** Plain sentences, safe to show a guest. */
  issues: string[];
}

export interface Itinerary {
  /** `needsStart` when neither the Plan nor its first stop states a time. */
  status: 'timed' | 'needsStart' | 'empty';
  stops: ItineraryStop[];
  /** Items that are not somewhere to spend time, such as parking. */
  skipped: { itemId: string; title: string }[];
  /** Only when a different order is clearly shorter and no less workable. */
  suggestedOrder: { itemIds: string[]; savesMeters: number } | null;
}

export const STOP_BUFFER_MINS = 10;

/** Typical lengths, shown as estimated. Unlisted kinds get the default. */
export const ESTIMATED_LENGTH_MINS: Readonly<Record<string, number>> = {
  coffee: 30,
  dining: 90,
  nightlife: 120,
  events: 120,
  wellness: 60,
  fitness: 60,
  shopping: 60,
  green: 60,
  stall: 30,
  automotive: 90,
};
export const DEFAULT_LENGTH_MINS = 60;

/** Getting there, or staying the night: not a stop on the timeline. */
const NOT_A_STOP = new Set(['parking', 'mobility', 'stay']);

/** Longest wait for a place to open before it counts as closed for the evening. */
const MAX_OPENING_WAIT_MINS = 180;

const SUGGEST_MAX_STOPS = 7;
const SUGGEST_MIN_SAVING_METERS = 800;
const SUGGEST_MIN_SAVING_SHARE = 0.2;
/** Extra idle time a suggested order may add before it stops being an improvement. */
const SUGGEST_MAX_EXTRA_WAIT_MINS = 15;

const TIME_ZONE = 'America/New_York';
const WEEK_MINS = 7 * 24 * 60;
const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

const clockLabel = (at: Date) =>
  new Intl.DateTimeFormat('en-US', { timeZone: TIME_ZONE, hour: 'numeric', minute: '2-digit' }).format(at);

const addMins = (at: Date, mins: number) => new Date(at.getTime() + mins * 60_000);

function localMinuteOfWeek(at: Date): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: TIME_ZONE, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(at);
  const part = (type: string) => parts.find((entry) => entry.type === type)?.value ?? '';
  return (WEEKDAYS[part('weekday')] ?? 0) * 1440 + Number(part('hour')) * 60 + Number(part('minute'));
}

type WeeklyHours = 'always' | [number, number][];

/** Minutes-of-week intervals. A lone period with no close is Google's "open 24 hours". */
function weeklyHours(periods: readonly OpeningPeriod[]): WeeklyHours | null {
  if (periods.length === 1 && !periods[0].close) return 'always';
  const intervals: [number, number][] = [];
  for (const period of periods) {
    if (!period.close) continue;
    const open = period.open.day * 1440 + period.open.hour * 60 + period.open.minute;
    let close = period.close.day * 1440 + period.close.hour * 60 + period.close.minute;
    if (close <= open) close += WEEK_MINS;
    intervals.push([open, close]);
  }
  return intervals.length > 0 ? intervals : null;
}

/** Minutes until closing if open at `minute`, else null. Checks the wrap past Saturday night. */
function minutesUntilClose(hours: [number, number][], minute: number): number | null {
  for (const [open, close] of hours) {
    for (const m of [minute, minute + WEEK_MINS]) {
      if (m >= open && m < close) return close - m;
    }
  }
  return null;
}

function minutesUntilOpen(hours: [number, number][], minute: number): number {
  return Math.min(...hours.map(([open]) => (((open - minute) % WEEK_MINS) + WEEK_MINS) % WEEK_MINS));
}

const placed = (leg: PlanLeg) => leg.latitude !== null && leg.longitude !== null;

function metersBetween(a: PlanLeg, b: PlanLeg): number | null {
  if (!placed(a) || !placed(b)) return null;
  return distanceMeters({ lat: a.latitude!, lng: a.longitude! }, { lat: b.latitude!, lng: b.longitude! });
}

function lengthOf(leg: PlanLeg): { mins: number; source: 'stated' | 'estimated' } {
  if (leg.durationMins !== null) return { mins: leg.durationMins, source: 'stated' };
  return { mins: ESTIMATED_LENGTH_MINS[leg.needKind] ?? DEFAULT_LENGTH_MINS, source: 'estimated' };
}

function schedule(stops: readonly ItineraryStopInput[], plan: ItineraryConstraints): { stops: ItineraryStop[]; anchored: boolean } {
  const first = stops[0];
  const anchor = plan.startsAt ?? (first?.leg.startsAt && first.timeSource ? first.leg.startsAt : null);
  let cursor: Date | null = anchor;
  const out: ItineraryStop[] = [];

  stops.forEach((input, index) => {
    const { leg } = input;
    const previous = index > 0 ? stops[index - 1].leg : null;
    const previousOut = index > 0 ? out[index - 1] : null;
    const length = lengthOf(leg);
    const meters = previous ? metersBetween(previous, leg) : null;
    const travel = meters === null ? null : { meters, atLeastMins: Math.ceil(meters / OPTIMISTIC_TRAVEL_METERS_PER_MIN) };
    const issues: string[] = [];
    if (!placed(leg)) issues.push('No location yet, so travel to and from here isn\'t counted.');

    const hours = input.hours ? weeklyHours(input.hours) : null;
    const fixed = input.timeSource && leg.startsAt ? leg.startsAt : null;
    let arriveAt: Date | null = null;
    let waitMins = 0;

    if (fixed) {
      arriveAt = fixed;
      if (cursor && previousOut) {
        const travelMins = travel?.atLeastMins ?? 0;
        if (fixed < cursor) {
          issues.push(`Starts at ${clockLabel(fixed)}, before you'd finish ${previousOut.title}.`);
        } else if (fixed < addMins(cursor, travelMins)) {
          issues.push(`Starts at ${clockLabel(fixed)}. There isn't time to get here from ${previousOut.title}.`);
        } else {
          waitMins = Math.max(0, Math.round((fixed.getTime() - addMins(cursor, travelMins + STOP_BUFFER_MINS).getTime()) / 60_000));
        }
      }
      if (cursor && !previousOut && fixed > cursor) {
        waitMins = Math.round((fixed.getTime() - cursor.getTime()) / 60_000);
      }
      if (plan.startsAt && fixed < plan.startsAt) issues.push('Starts before your Plan does.');
    } else if (cursor) {
      const earliest = previousOut ? addMins(cursor, (travel?.atLeastMins ?? 0) + STOP_BUFFER_MINS) : cursor;
      arriveAt = earliest;
      if (hours && hours !== 'always') {
        const minute = localMinuteOfWeek(earliest);
        if (minutesUntilClose(hours, minute) === null) {
          const wait = minutesUntilOpen(hours, minute);
          const opensAt = addMins(earliest, wait);
          if (wait <= MAX_OPENING_WAIT_MINS && (!plan.endsAt || opensAt < plan.endsAt)) {
            arriveAt = opensAt;
            waitMins = wait;
          } else {
            issues.push(`Closed at ${clockLabel(earliest)}.`);
          }
        }
      }
    }

    const leaveAt = arriveAt ? addMins(arriveAt, length.mins) : null;
    if (arriveAt && leaveAt && hours && hours !== 'always' && !fixed) {
      const untilClose = minutesUntilClose(hours, localMinuteOfWeek(arriveAt));
      if (untilClose !== null && untilClose < length.mins) {
        issues.push(`Closes at ${clockLabel(addMins(arriveAt, untilClose))}.`);
      }
    }
    if (leaveAt && plan.endsAt && leaveAt > plan.endsAt) {
      issues.push(`Runs past your Plan's end at ${clockLabel(plan.endsAt)}.`);
    }

    out.push({
      itemId: leg.itemId,
      title: leg.title,
      needKind: leg.needKind,
      arriveAt,
      leaveAt,
      time: arriveAt ? (fixed ? 'set' : 'estimated') : null,
      timeSource: fixed ? input.timeSource : null,
      lengthMins: length.mins,
      length: length.source,
      travel,
      waitMins,
      hours: hours ? 'known' : 'unknown',
      issues,
    });
    cursor = leaveAt ?? cursor;
  });

  return { stops: out, anchored: anchor !== null };
}

function totalMeters(stops: readonly ItineraryStopInput[]): number {
  let total = 0;
  for (let i = 1; i < stops.length; i += 1) total += metersBetween(stops[i - 1].leg, stops[i].leg) ?? 0;
  return total;
}

const issueCount = (stops: readonly ItineraryStop[]) => stops.reduce((sum, stop) => sum + stop.issues.length, 0);
const waitTotal = (stops: readonly ItineraryStop[]) => stops.reduce((sum, stop) => sum + stop.waitMins, 0);

function permutations<T>(items: readonly T[]): T[][] {
  if (items.length <= 1) return [[...items]];
  return items.flatMap((item, index) =>
    permutations([...items.slice(0, index), ...items.slice(index + 1)]).map((rest) => [item, ...rest]));
}

/**
 * A shorter order, only when it saves a real distance and adds no problem
 * and no real waiting. Without a Plan start, set times can't be compared, so a Plan with
 * any set time gets no suggestion.
 */
function suggestOrder(
  stops: readonly ItineraryStopInput[],
  plan: ItineraryConstraints,
  current: readonly ItineraryStop[],
): Itinerary['suggestedOrder'] {
  if (stops.length < 3 || stops.length > SUGGEST_MAX_STOPS) return null;
  if (!stops.every((stop) => placed(stop.leg))) return null;
  if (!plan.startsAt && stops.some((stop) => stop.timeSource && stop.leg.startsAt)) return null;

  const baseMeters = totalMeters(stops);
  const baseIssues = issueCount(current);
  const baseWait = waitTotal(current);
  let best: { order: ItineraryStopInput[]; meters: number } | null = null;
  for (const order of permutations(stops)) {
    const meters = totalMeters(order);
    if (best ? meters >= best.meters : meters >= baseMeters) continue;
    const timed = schedule(order, plan).stops;
    if (issueCount(timed) > baseIssues || waitTotal(timed) > baseWait + SUGGEST_MAX_EXTRA_WAIT_MINS) continue;
    best = { order, meters };
  }
  if (!best) return null;
  const saves = baseMeters - best.meters;
  if (saves < SUGGEST_MIN_SAVING_METERS || saves < baseMeters * SUGGEST_MIN_SAVING_SHARE) return null;
  return { itemIds: best.order.map((stop) => stop.leg.itemId), savesMeters: Math.round(saves) };
}

export function buildItinerary(inputs: readonly ItineraryStopInput[], plan: ItineraryConstraints): Itinerary {
  const skipped = inputs.filter((input) => NOT_A_STOP.has(input.leg.needKind))
    .map((input) => ({ itemId: input.leg.itemId, title: input.leg.title }));
  const stops = inputs.filter((input) => !NOT_A_STOP.has(input.leg.needKind));
  if (stops.length === 0) return { status: 'empty', stops: [], skipped, suggestedOrder: null };

  const timed = schedule(stops, plan);
  return {
    status: timed.anchored ? 'timed' : 'needsStart',
    stops: timed.stops,
    skipped,
    suggestedOrder: suggestOrder(stops, plan, timed.stops),
  };
}
