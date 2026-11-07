/**
 * Crowd readings for venue reads.
 *
 * A nested crowdLevels include with orderBy and take reads every reading for the
 * selected venues and trims per venue in memory, so it slows as the time
 * series grows. These helpers ask Postgres for only the rows returned, through
 * the (venue_id, recorded_at DESC) index.
 */

import type { CrowdLevel } from '@prisma/client';
import { db } from '../lib/db';
import { LIVE_OCCUPANCY_SOURCES, TYPICAL_SOURCE } from './typicalOccupancy';

/** Typical rows are a day-part curve, rewritten every 15 minutes; reads use at most the last 24. */
export const TYPICAL_RETENTION_MS = 2 * 24 * 60 * 60 * 1000;

/** A live reading (a proven check-in or a confirmed guest report) is shown over the typical curve for this long. */
export const LIVE_CROWD_FRESH_MS = 30 * 60 * 1000;
export const REPORTED_CROWD_SOURCE = 'user_report' as const;
/** What a confirmed guest report says about a venue. A long line is not a wait time, so none is stated. */
export const REPORTED_CROWD = {
  packed: { level: 4, label: 'Packed' },
  long_line: { level: 3, label: 'Busy' },
} as const;

type ConfirmedCrowdReport = { id: string; venueId: string | null; kind: string; confirmedAt: Date | null };

/** Active, confirmed packed and long-line reports for these venues, as crowd readings. */
async function reportedCrowd(venueIds: string[], now: Date): Promise<CrowdLevel[]> {
  try {
    const reports = await db.mapReport.findMany({
      where: {
        venueId: { in: venueIds }, kind: { in: Object.keys(REPORTED_CROWD) }, confirmedAt: { not: null },
        removedAt: null, expiresAt: { gt: now }, reporter: { suspendedAt: null, deletedAt: null },
      },
      select: { id: true, venueId: true, kind: true, confirmedAt: true },
    }) as ConfirmedCrowdReport[];
    return reports.flatMap((r) => {
      const said = REPORTED_CROWD[r.kind as keyof typeof REPORTED_CROWD];
      return said && r.venueId && r.confirmedAt ? [{ id: `report:${r.id}`, venueId: r.venueId, level: said.level, label: said.label,
        waitMins: null, source: REPORTED_CROWD_SOURCE, recordedAt: r.confirmedAt }] : [];
    });
  } catch {
    // A crowd read never fails because reports could not be read.
    return [];
  }
}

function isFreshLive(row: CrowdLevel, now: Date): boolean {
  return (LIVE_OCCUPANCY_SOURCES as readonly string[]).includes(row.source)
    && now.getTime() - new Date(row.recordedAt).getTime() <= LIVE_CROWD_FRESH_MS;
}

/**
 * The reading a venue shows. A fresh live reading beats the typical curve, which
 * is rewritten every 15 minutes. Among live readings the highest level wins:
 * check-ins count only members, so they are a floor, and a confirmed report has
 * other members' agreement. Otherwise the newest reading of any kind.
 */
export function currentCrowd(rows: CrowdLevel[], now: Date): CrowdLevel | undefined {
  const newest = (a: CrowdLevel, b: CrowdLevel) => new Date(b.recordedAt).getTime() - new Date(a.recordedAt).getTime();
  const live = rows.filter((row) => isFreshLive(row, now)).sort((a, b) => b.level - a.level || newest(a, b));
  return live[0] ?? [...rows].sort(newest)[0];
}

export async function latestCrowdByVenue(venueIds: string[], now = new Date()): Promise<Map<string, CrowdLevel>> {
  if (venueIds.length === 0) return new Map();
  const since = new Date(now.getTime() - LIVE_CROWD_FRESH_MS);
  const live = [...LIVE_OCCUPANCY_SOURCES];
  // Per venue: its newest fresh live reading if any, else its newest reading.
  const [rows, reported] = await Promise.all([db.$queryRaw<CrowdLevel[]>`
    SELECT c.id, c.venue_id AS "venueId", c.level, c.label, c.wait_mins AS "waitMins", c.source, c.recorded_at AS "recordedAt"
    FROM unnest(${venueIds}::text[]) AS v(id)
    CROSS JOIN LATERAL (
      SELECT id, venue_id, level, label, wait_mins, source, recorded_at
      FROM crowd_levels
      WHERE venue_id = v.id
      ORDER BY (source = ANY(${live}::text[]) AND recorded_at >= ${since}) DESC, recorded_at DESC
      LIMIT 1
    ) c`, reportedCrowd(venueIds, now)]);
  const byVenue = new Map<string, CrowdLevel[]>();
  for (const row of [...rows, ...reported]) byVenue.set(row.venueId, [...(byVenue.get(row.venueId) ?? []), row]);
  const current = new Map<string, CrowdLevel>();
  for (const [venueId, candidates] of byVenue) {
    const reading = currentCrowd(candidates, now);
    if (reading) current.set(venueId, reading);
  }
  return current;
}

/** Attaches the newest reading as `crowdLevels: [reading]`, the shape the nested include returned. */
export async function withLatestCrowd<T extends { id: string }>(venues: T[]): Promise<Array<T & { crowdLevels: CrowdLevel[] }>> {
  const latest = await latestCrowdByVenue(venues.map((venue) => venue.id));
  return venues.map((venue) => {
    const reading = latest.get(venue.id);
    return { ...venue, crowdLevels: reading ? [reading] : [] };
  });
}

/** Newest first, except the reading the venue shows now (see `currentCrowd`), which is first. */
export async function recentCrowd(venueId: string, take: number, now = new Date()): Promise<CrowdLevel[]> {
  const [history, reported] = await Promise.all([
    db.crowdLevel.findMany({ where: { venueId }, orderBy: { recordedAt: 'desc' }, take }),
    reportedCrowd([venueId], now),
  ]);
  const current = currentCrowd([...history, ...reported], now);
  return current ? [current, ...history.filter((row) => row.id !== current.id)].slice(0, take) : history;
}

export async function pruneTypicalCrowd(now = new Date()): Promise<number> {
  const { count } = await db.crowdLevel.deleteMany({
    where: { source: TYPICAL_SOURCE, recordedAt: { lt: new Date(now.getTime() - TYPICAL_RETENTION_MS) } },
  });
  return count;
}
