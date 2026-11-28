/**
 * Best time to go — an estimate from the typical day-part curve.
 *
 * Every slot is what a place is usually like at that Atlanta hour, not a live
 * count. `source` is always `typical`. A fresh live reading (bytspot,
 * user_report, or sensor, no older than latestCrowd.LIVE_CROWD_FRESH_MS) may
 * be attached as `rightNow`. It never rewrites the curve.
 *
 * There is no directions provider in bytspot-api (travel elsewhere is a
 * straight-line estimate, not a route). `origin` is accepted and ignored.
 * Leave-by is filled only when the caller already knows `driveMinutes`.
 */

import { LIVE_CROWD_FRESH_MS } from './latestCrowd';
import {
  TYPICAL_LABELS,
  TYPICAL_SOURCE,
  clampLevel,
  isLiveOccupancySource,
  typicalJitter,
  typicalLevel,
  typicalWaitMins,
} from './typicalOccupancy';

const ATLANTA = 'America/New_York';

/** Next six hours when the caller does not name a window. */
export const BEST_TIME_DEFAULT_WINDOW_MS = 6 * 60 * 60 * 1000;
/** A party overnight fits; a multi-day sweep does not. */
export const BEST_TIME_MAX_WINDOW_MS = 18 * 60 * 60 * 1000;
const MAX_SLOTS = 48;

export interface BestTimeVenue {
  category: string;
  /** Salt for typicalJitter so two places on the same curve are not identical. */
  slug: string;
}

export interface BestTimeLiveReading {
  level: number;
  label?: string | null;
  source: string;
  recordedAt: Date | string;
}

export interface BestTimeToGoInput {
  venue: BestTimeVenue;
  window: { startsAt: Date; endsAt: Date };
  /** 15 when the window is short, otherwise 30, unless the caller chooses. */
  slotMinutes?: 15 | 30;
  /** Known drive time. Unknown (null or omitted) means no leave-by. */
  driveMinutes?: number | null;
  /**
   * Where the guest is. Not turned into a drive time: no routes helper exists.
   */
  origin?: { lat: number; lng: number } | null;
  live?: BestTimeLiveReading | null;
  now?: Date;
}

export interface ArrivalSlot {
  arrivalAt: string;
  level: number;
  label: string;
  waitMins: number;
  driveMinutes?: number;
  leaveBy?: string;
}

export interface BestTimeRightNow {
  level: number;
  label: string;
  source: string;
  recordedAt: string;
  line: string;
}

export interface BestTimeToGo {
  source: typeof TYPICAL_SOURCE;
  slotMinutes: 15 | 30;
  /** One honest line, e.g. "Typically quieter before 9:30 PM (estimate)". */
  summary: string;
  /** Null when the caller did not supply a known drive time. */
  driveMinutes: number | null;
  window: { startsAt: string; endsAt: string };
  /** Arrival of the first ranked slot. Null when the window has no slot. */
  preferredArrivalAt: string | null;
  /** Leave-by for that arrival. Null when drive time is unknown or there is no slot. */
  preferredLeaveBy: string | null;
  /** Calmest first, then earlier. */
  slots: ArrivalSlot[];
  rightNow: BestTimeRightNow | null;
}

interface BuiltSlot {
  at: Date;
  level: number;
  label: string;
  waitMins: number;
}

export function defaultSlotMinutes(windowMs: number): 15 | 30 {
  return windowMs <= 3 * 60 * 60 * 1000 ? 15 : 30;
}

/** Next grid boundary in absolute time. Atlanta's offset is a whole hour, so :00/:15/:30/:45 match the local clock. */
export function alignArrival(date: Date, slotMinutes: 15 | 30): Date {
  const step = slotMinutes * 60_000;
  return new Date(Math.ceil(date.getTime() / step) * step);
}

export function detailBestTimeWindow(now = new Date()): { startsAt: Date; endsAt: Date; slotMinutes: 30 } {
  const slotMinutes = 30 as const;
  const startsAt = alignArrival(now, slotMinutes);
  return { startsAt, endsAt: new Date(startsAt.getTime() + BEST_TIME_DEFAULT_WINDOW_MS), slotMinutes };
}

export function bestTimeCacheKey(slug: string, slotMinutes: number, startsAt: Date, endsAt: Date, driveMinutes: number | null): string {
  return `venue:best-time:v1:${slug}:${slotMinutes}:${startsAt.toISOString()}:${endsAt.toISOString()}:${driveMinutes ?? 'none'}`;
}

function atlantaParts(date: Date): { year: string; month: string; day: string; hour: number; minute: number; second: number; weekday: number; offset: string } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: ATLANTA,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    weekday: 'short', hourCycle: 'h23',
  }).formatToParts(date);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
  let hour = Number(get('hour'));
  if (hour === 24) hour = 0;
  let second = Number(get('second'));
  if (second === 60) second = 0;
  const zone = new Intl.DateTimeFormat('en-US', { timeZone: ATLANTA, timeZoneName: 'longOffset' })
    .formatToParts(date).find((part) => part.type === 'timeZoneName')?.value ?? 'GMT-05:00';
  const offset = zone.match(/GMT([+-]\d{2}:\d{2})/)?.[1] ?? '-05:00';
  return {
    year: get('year'), month: get('month'), day: get('day'),
    hour, minute: Number(get('minute')), second,
    weekday: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(get('weekday')),
    offset,
  };
}

export function formatAtlantaIso(date: Date): string {
  const part = atlantaParts(date);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${part.year}-${part.month}-${part.day}T${pad(part.hour)}:${pad(part.minute)}:${pad(part.second)}${part.offset}`;
}

export function formatAtlantaClock(date: Date): string {
  return new Intl.DateTimeFormat('en-US', { timeZone: ATLANTA, hour: 'numeric', minute: '2-digit' }).format(date);
}

function knownDrive(value: number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  if (!Number.isInteger(value) || value < 0 || value > 180) return null;
  return value;
}

function slotInstants(start: Date, end: Date, slotMinutes: 15 | 30): Date[] {
  if (!(start < end) || Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return [];
  const step = slotMinutes * 60_000;
  const out: Date[] = [];
  for (let cursor = alignArrival(start, slotMinutes); cursor < end && out.length < MAX_SLOTS; cursor = new Date(cursor.getTime() + step)) {
    out.push(cursor);
  }
  return out;
}

function summaryFor(slots: BuiltSlot[]): string {
  if (slots.length === 0) return 'No arrival times in this window (estimate)';
  const best = Math.min(...slots.map((slot) => slot.level));
  const label = (TYPICAL_LABELS[best] ?? 'Active').toLowerCase();
  if (slots.every((slot) => slot.level === best)) return `Typically ${label} through this window (estimate)`;
  const prefixEnd = slots.findIndex((slot) => slot.level !== best);
  if (prefixEnd > 0 && slots.slice(prefixEnd).every((slot) => slot.level !== best)) {
    return `Typically quieter before ${formatAtlantaClock(slots[prefixEnd].at)} (estimate)`;
  }
  const firstBest = slots.findIndex((slot) => slot.level === best);
  if (firstBest > 0 && slots.slice(firstBest).every((slot) => slot.level === best)) {
    return `Typically quieter after ${formatAtlantaClock(slots[firstBest].at)} (estimate)`;
  }
  return `Typically quieter around ${formatAtlantaClock(slots[firstBest].at)} (estimate)`;
}

export function rightNowFrom(live: BestTimeLiveReading | null | undefined, now: Date): BestTimeRightNow | null {
  if (!live || !isLiveOccupancySource(live.source)) return null;
  const at = new Date(live.recordedAt);
  if (Number.isNaN(at.getTime())) return null;
  // Same freshness test as latestCrowd.isFreshLive: recorded within LIVE_CROWD_FRESH_MS.
  if (now.getTime() - at.getTime() > LIVE_CROWD_FRESH_MS) return null;
  const level = clampLevel(live.level);
  const label = TYPICAL_LABELS[level] ?? 'Active';
  return {
    level,
    label,
    source: live.source,
    recordedAt: formatAtlantaIso(at),
    line: `Right now it's ${label.toLowerCase()}.`,
  };
}

function toArrival(slot: BuiltSlot, driveMinutes: number | null): ArrivalSlot {
  const arrival: ArrivalSlot = {
    arrivalAt: formatAtlantaIso(slot.at),
    level: slot.level,
    label: slot.label,
    waitMins: slot.waitMins,
  };
  if (driveMinutes === null) return arrival;
  return {
    ...arrival,
    driveMinutes,
    leaveBy: formatAtlantaIso(new Date(slot.at.getTime() - driveMinutes * 60_000)),
  };
}

/** Rank arrival slots on the typical curve. Does not read the database. */
export function bestTimeToGo(input: BestTimeToGoInput): BestTimeToGo {
  // Origin cannot become a drive time until a routes helper exists.
  void input.origin;
  const now = input.now ?? new Date();
  const start = input.window.startsAt;
  const end = input.window.endsAt;
  const span = end.getTime() - start.getTime();
  const slotMinutes = input.slotMinutes ?? defaultSlotMinutes(Number.isFinite(span) && span > 0 ? span : 0);
  const driveMinutes = knownDrive(input.driveMinutes);
  const built = slotInstants(start, end, slotMinutes).map((at) => {
    const { hour, weekday } = atlantaParts(at);
    const level = typicalJitter(typicalLevel(hour, weekday, input.venue.category), input.venue.slug, hour, weekday);
    return { at, level, label: TYPICAL_LABELS[level] ?? 'Active', waitMins: typicalWaitMins(level) };
  });
  const summary = summaryFor(built);
  const ranked = [...built].sort((a, b) => a.level - b.level || a.at.getTime() - b.at.getTime());
  const slots = ranked.map((slot) => toArrival(slot, driveMinutes));
  return {
    source: TYPICAL_SOURCE,
    slotMinutes,
    summary,
    driveMinutes,
    window: {
      startsAt: formatAtlantaIso(start),
      endsAt: formatAtlantaIso(end),
    },
    preferredArrivalAt: slots[0]?.arrivalAt ?? null,
    preferredLeaveBy: slots[0]?.leaveBy ?? null,
    slots,
    rightNow: rightNowFrom(input.live, now),
  };
}

/** Copy a cached typical estimate and attach a fresh live reading, if one exists. */
export function attachRightNow(estimate: BestTimeToGo, live: BestTimeLiveReading | null | undefined, now = new Date()): BestTimeToGo {
  return {
    ...estimate,
    slots: estimate.slots.map((slot) => ({ ...slot })),
    rightNow: rightNowFrom(live, now),
  };
}

/** Venue detail: the next six hours, thirty-minute slots, no invented drive time. */
export function bestTimeForVenueDetail(
  venue: BestTimeVenue,
  crowd: BestTimeLiveReading | null | undefined,
  now = new Date(),
): BestTimeToGo {
  const window = detailBestTimeWindow(now);
  return bestTimeToGo({
    venue,
    window: { startsAt: window.startsAt, endsAt: window.endsAt },
    slotMinutes: window.slotMinutes,
    live: crowd ?? null,
    now,
  });
}
