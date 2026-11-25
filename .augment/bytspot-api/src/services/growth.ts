/**
 * The admin Growth tab: is Bytspot being used with friends, do invites bring
 * people in, and do people come back. Counts only; no member is named.
 *
 * Days are UTC calendar days, as recorded in user_active_days. Coming-back
 * figures only cover members who signed up after day tracking began, and only
 * once their whole window has passed, so a figure is never a guess.
 */
import { db } from '../lib/db';
import { activeDayOf } from './activity';
import { homeTapCounts, type HomeBlock } from './homeTaps';

export const GROWTH_WEEKS = 8;

/** How far back the Growth tab looks. Up to 3 months is shown by week, longer by month. */
export const GROWTH_RANGES = ['8w', '3m', '6m', '12m'] as const;
export type GrowthRange = (typeof GROWTH_RANGES)[number];
export type GrowthBucket = 'week' | 'month';

export function rangeShape(range: GrowthRange): { bucket: GrowthBucket; count: number } {
  switch (range) {
    case '3m': return { bucket: 'week', count: 13 };
    case '6m': return { bucket: 'month', count: 6 };
    case '12m': return { bucket: 'month', count: 12 };
    default: return { bucket: 'week', count: GROWTH_WEEKS };
  }
}
const DAY_MS = 24 * 60 * 60 * 1000;

export interface GrowthWeek {
  weekStart: string;
  activeUsers: number;
  newUsers: number;
  /** New members who joined a friend's Plan or Party within a day of signing up, or signed up with a member's invite code. */
  newFromInvites: number;
  plansCreated: number;
  /** Plans created this week that at least one friend joined. */
  plansWithFriends: number;
  /** Friends who joined someone's Plan. */
  planJoins: number;
  partyJoins: number;
  /** Plan and Party share pages opened in a browser (link previews not counted). */
  shareViews: number;
  bookingTaps: number;
  checkIns: number;
  /** Taps on each block of the app's Home screen. */
  homeTaps: Record<HomeBlock, number>;
}

export interface RetentionCohort {
  weekStart: string;
  signedUp: number;
  /** Percent who came back the day after signing up; null until anyone's day has passed. */
  day1: number | null;
  /** Percent who came back within 7 days. */
  week1: number | null;
  /** Percent who came back between day 8 and day 30. */
  month1: number | null;
}

export interface GrowthReport {
  generatedAt: string;
  range: GrowthRange;
  /** Whether each column (and each coming-back row) is a week starting Monday or a calendar month. `weekStart` is its first day either way. */
  bucket: GrowthBucket;
  /** First day active-user tracking recorded anything; null before the first signed-in visit. */
  trackingSince: string | null;
  totalMembers: number;
  weeks: GrowthWeek[];
  retention: RetentionCohort[];
}

/** Monday 00:00 UTC of the last `count` weeks, oldest first, ending with this week. */
export function weekStarts(now: Date, count = GROWTH_WEEKS): Date[] {
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const monday = today - ((now.getUTCDay() + 6) % 7) * DAY_MS;
  return Array.from({ length: count }, (_, i) => new Date(monday - (count - 1 - i) * 7 * DAY_MS));
}

/** The 1st of each of the last `count` months (UTC), oldest first, ending with this month. */
export function monthStarts(now: Date, count: number): Date[] {
  return Array.from({ length: count }, (_, i) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (count - 1 - i), 1)));
}

/** Where each bucket starts and where it ends (the next bucket's start). */
export function bucketBounds(now: Date, range: GrowthRange): { bucket: GrowthBucket; starts: Date[]; ends: Date[] } {
  const { bucket, count } = rangeShape(range);
  const starts = bucket === 'week' ? weekStarts(now, count) : monthStarts(now, count);
  const ends = starts.map((start) => (bucket === 'week'
    ? new Date(start.getTime() + 7 * DAY_MS)
    : new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1))));
  return { bucket, starts, ends };
}

const plusDays = (day: string, days: number) => activeDayOf(new Date(Date.parse(`${day}T00:00:00Z`) + days * DAY_MS));

/** Coming-back percentages for one signup week. */
export function retentionFor(
  weekStart: Date,
  members: { createdAt: Date; activeDays: readonly string[] }[],
  now: Date,
): RetentionCohort {
  const today = activeDayOf(now);
  const window = (from: number, to: number) => {
    let eligible = 0;
    let returned = 0;
    for (const member of members) {
      const signup = activeDayOf(member.createdAt);
      if (plusDays(signup, to) >= today) continue;
      eligible += 1;
      const first = plusDays(signup, from);
      const last = plusDays(signup, to);
      if (member.activeDays.some((day) => day >= first && day <= last)) returned += 1;
    }
    return eligible ? Math.round((returned / eligible) * 100) : null;
  };
  return { weekStart: activeDayOf(weekStart), signedUp: members.length, day1: window(1, 1), week1: window(1, 7), month1: window(8, 30) };
}

async function countWeek(start: Date, end: Date): Promise<GrowthWeek> {
  const inWeek = { gte: start, lt: end };
  const [active, newUsers, invited, plansCreated, plansWithFriends, planJoins, partyJoins, shareViews, bookingTaps, checkIns] = await Promise.all([
    db.$queryRaw<{ n: number }[]>`SELECT COUNT(DISTINCT "user_id")::int AS n FROM "user_active_days"
      WHERE "day" >= ${activeDayOf(start)}::date AND "day" < ${activeDayOf(end)}::date`,
    db.user.count({ where: { createdAt: inWeek } }),
    db.$queryRaw<{ n: number }[]>`SELECT COUNT(*)::int AS n FROM "users" u
      WHERE u."created_at" >= ${start} AND u."created_at" < ${end} AND (
        EXISTS (SELECT 1 FROM "plan_participants" p WHERE p."user_id" = u."id" AND p."role" = 'guest'
          AND p."created_at" BETWEEN u."created_at" AND u."created_at" + INTERVAL '1 day')
        OR EXISTS (SELECT 1 FROM "party_guests" g WHERE g."user_id" = u."id"
          AND g."created_at" BETWEEN u."created_at" AND u."created_at" + INTERVAL '1 day')
        OR EXISTS (SELECT 1 FROM "users" r WHERE r."id" = u."ref"))`,
    db.plan.count({ where: { createdAt: inWeek } }),
    db.plan.count({ where: { createdAt: inWeek, participants: { some: { role: 'guest', status: { notIn: ['removed', 'declined'] } } } } }),
    db.planParticipant.count({ where: { role: 'guest', createdAt: inWeek } }),
    db.partyGuest.count({ where: { createdAt: inWeek } }),
    db.shareLinkView.count({ where: { viewedAt: inWeek } }),
    db.bookingLinkTap.count({ where: { createdAt: inWeek } }),
    db.checkIn.count({ where: { createdAt: inWeek, proof: { not: 'self_reported' } } }),
  ]);
  const homeTaps = await homeTapCounts(start, end);
  return {
    weekStart: activeDayOf(start), activeUsers: active[0]?.n ?? 0, newUsers, newFromInvites: invited[0]?.n ?? 0,
    plansCreated, plansWithFriends, planJoins, partyJoins, shareViews, bookingTaps, checkIns, homeTaps,
  };
}

export async function loadGrowthReport(now = new Date(), range: GrowthRange = '8w'): Promise<GrowthReport> {
  const { bucket, starts, ends } = bucketBounds(now, range);
  const weeks: GrowthWeek[] = [];
  for (let i = 0; i < starts.length; i += 3) {
    weeks.push(...await Promise.all(starts.slice(i, i + 3).map((start, j) => countWeek(start, ends[i + j]))));
  }

  const [first, totalMembers] = await Promise.all([
    db.userActiveDay.findFirst({ orderBy: { day: 'asc' }, select: { day: true } }),
    db.user.count({ where: { deletedAt: null } }),
  ]);
  const trackingSince = first ? activeDayOf(first.day) : null;

  let retention: RetentionCohort[] = [];
  if (trackingSince) {
    const tracked = new Date(`${trackingSince}T00:00:00Z`);
    const members = await db.user.findMany({
      where: { createdAt: { gte: new Date(Math.max(starts[0].getTime(), tracked.getTime())) } },
      select: { createdAt: true, activeDays: { select: { day: true } } },
    });
    retention = starts.map((start, i) => retentionFor(start,
      members.filter((m) => m.createdAt >= start && m.createdAt < ends[i])
        .map((m) => ({ createdAt: m.createdAt, activeDays: m.activeDays.map((d) => activeDayOf(d.day)) })),
      now)).filter((cohort) => cohort.signedUp > 0);
  }

  return { generatedAt: now.toISOString(), range, bucket, trackingSince, totalMembers, weeks, retention };
}
