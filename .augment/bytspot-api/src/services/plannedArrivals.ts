import { Prisma } from '@prisma/client';
import { db } from '../lib/db';
import { zonedInstant } from '../vendor/availability';

/**
 * How many distinct plans expect to arrive at a venue, by slot.
 *
 * Server-only. This is not mounted on a guest router, and Plan serialization
 * does not copy `venueId` or `arrivesAt`. Nash (N2) will read it when ranking;
 * a guest must not.
 *
 * Slots are boundaries on the America/New_York clock, the launch market's
 * zone. A count is distinct plans, not items: two stops of one plan in the
 * same slot are one arrival. Cancelled items, cancelled plans, deleted plans,
 * proposed plans whose invite has expired, and confirmed plans that have
 * ended are left out. The plan asking (planId) is left out so it is not
 * counted as its own competition.
 *
 * The columns are a stamp. A party start that moves after the item was
 * written, or a venue linked only later, stays stale until a write or the
 * backfill restamps it. N2 must not assume a live join back to the party.
 */

/** Launch-market zone. Matches areaTimeZone's LAUNCH_TIME_ZONE. */
export const ARRIVAL_TIME_ZONE = 'America/New_York';

/**
 * A confirmed Plan with a start and no stated end is over this long after it
 * starts. The same length planRouter uses for planEffectiveEnd.
 */
const CONFIRMED_PLAN_LENGTH_MS = 12 * 60 * 60 * 1000;

export interface PlannedArrivalSlot {
  /** Instant the America/New_York slot opens. Half-open: [slotStart, next). */
  slotStart: Date;
  count: number;
}

export interface PlannedArrivalQuery {
  from: Date;
  to: Date;
  /** Width of a slot on the New York clock. Default 30. */
  slotMinutes?: number;
  /** The plan asking, omitted from the counts. */
  planId?: string;
  /** Clock for "ended" and "expired". Defaults to now. */
  now?: Date;
}

export interface ArrivalFact {
  planId: string;
  venueId: string | null;
  arrivesAt: Date | null;
  status: string;
  plan: {
    lifecycle: string;
    cancelledAt: Date | null;
    deletedAt: Date | null;
    startsAt: Date | null;
    endsAt: Date | null;
    expiresAt: Date | null;
  };
}

const arrivalSelect = {
  planId: true,
  venueId: true,
  arrivesAt: true,
  status: true,
  plan: {
    select: {
      lifecycle: true,
      cancelledAt: true,
      deletedAt: true,
      startsAt: true,
      endsAt: true,
      expiresAt: true,
    },
  },
} as const;

export interface ArrivalReader {
  findMany(args: { where: Prisma.PlanItemWhereInput; select: typeof arrivalSelect }): Promise<ArrivalFact[]>;
}

/** A plan that can still bring people to a future stop. */
export function planCountsTowardArrivals(plan: ArrivalFact['plan'], now: Date): boolean {
  if (plan.deletedAt || plan.cancelledAt || plan.lifecycle === 'cancelled') return false;
  // A proposed Plan that ran out of time is expired on read. There is no sweep.
  if (plan.lifecycle === 'proposed' && plan.expiresAt && now >= plan.expiresAt) return false;
  if (plan.lifecycle === 'confirmed') {
    const end = plan.endsAt ?? (plan.startsAt ? new Date(plan.startsAt.getTime() + CONFIRMED_PLAN_LENGTH_MS) : null);
    if (end && now >= end) return false;
  }
  return true;
}

/**
 * Slot series for one venue. Every slot that overlaps [from, to) is returned,
 * including those whose count is zero, so a caller can see a gap. slotStart
 * is the New York boundary that contains the arrival, not the query's `from`
 * when that falls mid-slot. Arrivals with no venue, no time, a cancelled
 * item, or a plan that no longer counts are ignored.
 */
export function countPlannedArrivalSlots(rows: readonly ArrivalFact[], input: PlannedArrivalQuery & { venueId: string }): PlannedArrivalSlot[] {
  const slotMinutes = slotMinutesOf(input.slotMinutes);
  assertWindow(input.from, input.to);
  const now = input.now ?? new Date();
  const slots = slotsInWindow(input.from, input.to, slotMinutes);
  const plansBySlot = new Map<number, Set<string>>(slots.map((slot) => [slot.getTime(), new Set()]));
  for (const row of rows) {
    if (row.venueId !== input.venueId || row.arrivesAt == null) continue;
    if (Number.isNaN(row.arrivesAt.getTime())) continue;
    if (row.status === 'cancelled') continue;
    if (input.planId && row.planId === input.planId) continue;
    if (!planCountsTowardArrivals(row.plan, now)) continue;
    if (row.arrivesAt < input.from || row.arrivesAt >= input.to) continue;
    const slot = slotStartContaining(row.arrivesAt, slotMinutes);
    plansBySlot.get(slot.getTime())?.add(row.planId);
  }
  return slots.map((slotStart) => ({ slotStart, count: plansBySlot.get(slotStart.getTime())?.size ?? 0 }));
}

/** The where-clause the indexed read uses. The counter applies the same rules again. */
export function plannedArrivalWhere(input: {
  venueIds: readonly string[];
  from: Date;
  to: Date;
  planId?: string;
  now: Date;
}): Prisma.PlanItemWhereInput {
  const endedBefore = new Date(input.now.getTime() - CONFIRMED_PLAN_LENGTH_MS);
  return {
    venueId: { in: [...input.venueIds] },
    arrivesAt: { gte: input.from, lt: input.to },
    status: { not: 'cancelled' },
    plan: {
      deletedAt: null,
      cancelledAt: null,
      lifecycle: { not: 'cancelled' },
      ...(input.planId ? { id: { not: input.planId } } : {}),
      AND: [
        {
          OR: [
            { lifecycle: { not: 'proposed' } },
            { expiresAt: null },
            { expiresAt: { gt: input.now } },
          ],
        },
        {
          OR: [
            { lifecycle: { not: 'confirmed' } },
            { endsAt: { gt: input.now } },
            {
              AND: [
                { endsAt: null },
                { OR: [{ startsAt: null }, { startsAt: { gt: endedBefore } }] },
              ],
            },
          ],
        },
      ],
    },
  };
}

export async function plannedArrivalsForVenues(
  input: PlannedArrivalQuery & { venueIds: readonly string[] },
  reader: ArrivalReader = defaultReader(),
): Promise<{ venueId: string; slots: PlannedArrivalSlot[] }[]> {
  const venueIds = [...new Set(input.venueIds.filter((id) => id.length > 0))];
  const now = input.now ?? new Date();
  const empty = () => venueIds.map((venueId) => ({
    venueId,
    slots: countPlannedArrivalSlots([], { ...input, venueId, now }),
  }));
  if (venueIds.length === 0) return [];
  assertWindow(input.from, input.to);
  if (!(input.from < input.to)) return empty();
  const rows = await reader.findMany({
    where: plannedArrivalWhere({ venueIds, from: input.from, to: input.to, planId: input.planId, now }),
    select: arrivalSelect,
  });
  return venueIds.map((venueId) => ({
    venueId,
    slots: countPlannedArrivalSlots(rows, { ...input, venueId, now }),
  }));
}

export async function plannedArrivals(
  input: PlannedArrivalQuery & { venueId: string },
  reader?: ArrivalReader,
): Promise<PlannedArrivalSlot[]> {
  const [result] = await plannedArrivalsForVenues({ ...input, venueIds: [input.venueId] }, reader);
  return result?.slots ?? [];
}

function defaultReader(): ArrivalReader {
  return {
    findMany: (args) => db.planItem.findMany(args),
  };
}

function slotMinutesOf(value: number | undefined): number {
  const minutes = value ?? 30;
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 24 * 60) {
    throw new RangeError('slotMinutes must be a whole number of minutes from 1 to 1440.');
  }
  return minutes;
}

function assertWindow(from: Date, to: Date): void {
  if (!(from instanceof Date) || !(to instanceof Date) || Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
    throw new RangeError('Arrival window needs real instants.');
  }
}

function wallParts(instant: Date): { year: number; month: number; day: number; minuteOfDay: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: ARRIVAL_TIME_ZONE,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(instant);
  const read = (type: string): number => Number(parts.find((part) => part.type === type)?.value ?? '0');
  // Hour 24 is how this formatter spells midnight. Left as 24 it would floor
  // into the next day and an arrival just after midnight would miss its slot.
  const hour = read('hour') % 24;
  return { year: read('year'), month: read('month'), day: read('day'), minuteOfDay: hour * 60 + read('minute') };
}

function addCalendarDays(year: number, month: number, day: number, days: number): { year: number; month: number; day: number } {
  const shifted = new Date(Date.UTC(year, month - 1, day + days));
  return { year: shifted.getUTCFullYear(), month: shifted.getUTCMonth() + 1, day: shifted.getUTCDate() };
}

function slotStartContaining(instant: Date, slotMinutes: number): Date {
  const wall = wallParts(instant);
  const floored = Math.floor(wall.minuteOfDay / slotMinutes) * slotMinutes;
  return zonedInstant(wall.year, wall.month, wall.day, floored, ARRIVAL_TIME_ZONE);
}

function nextSlotStart(slotStart: Date, slotMinutes: number): Date {
  const wall = wallParts(slotStart);
  const advanced = wall.minuteOfDay + slotMinutes;
  const carry = Math.floor(advanced / (24 * 60));
  const minuteOfDay = advanced % (24 * 60);
  const date = addCalendarDays(wall.year, wall.month, wall.day, carry);
  return zonedInstant(date.year, date.month, date.day, minuteOfDay, ARRIVAL_TIME_ZONE);
}

function slotsInWindow(from: Date, to: Date, slotMinutes: number): Date[] {
  if (!(from < to)) return [];
  const slots: Date[] = [];
  let cursor = slotStartContaining(from, slotMinutes);
  const cap = Math.ceil((to.getTime() - cursor.getTime()) / 60_000) + 2;
  while (cursor < to && slots.length < cap) {
    slots.push(cursor);
    const next = nextSlotStart(cursor, slotMinutes);
    if (next.getTime() <= cursor.getTime()) break;
    cursor = next;
  }
  return slots;
}
