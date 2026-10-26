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
import { TYPICAL_SOURCE } from './typicalOccupancy';

/** Typical rows are a day-part curve, rewritten every 15 minutes; reads use at most the last 24. */
export const TYPICAL_RETENTION_MS = 2 * 24 * 60 * 60 * 1000;

export async function latestCrowdByVenue(venueIds: string[]): Promise<Map<string, CrowdLevel>> {
  if (venueIds.length === 0) return new Map();
  const rows = await db.$queryRaw<CrowdLevel[]>`
    SELECT c.id, c.venue_id AS "venueId", c.level, c.label, c.wait_mins AS "waitMins", c.source, c.recorded_at AS "recordedAt"
    FROM unnest(${venueIds}::text[]) AS v(id)
    CROSS JOIN LATERAL (
      SELECT id, venue_id, level, label, wait_mins, source, recorded_at
      FROM crowd_levels
      WHERE venue_id = v.id
      ORDER BY recorded_at DESC
      LIMIT 1
    ) c`;
  return new Map(rows.map((row) => [row.venueId, row]));
}

/** Attaches the newest reading as `crowdLevels: [reading]`, the shape the nested include returned. */
export async function withLatestCrowd<T extends { id: string }>(venues: T[]): Promise<Array<T & { crowdLevels: CrowdLevel[] }>> {
  const latest = await latestCrowdByVenue(venues.map((venue) => venue.id));
  return venues.map((venue) => {
    const reading = latest.get(venue.id);
    return { ...venue, crowdLevels: reading ? [reading] : [] };
  });
}

export function recentCrowd(venueId: string, take: number): Promise<CrowdLevel[]> {
  return db.crowdLevel.findMany({ where: { venueId }, orderBy: { recordedAt: 'desc' }, take });
}

export async function pruneTypicalCrowd(now = new Date()): Promise<number> {
  const { count } = await db.crowdLevel.deleteMany({
    where: { source: TYPICAL_SOURCE, recordedAt: { lt: new Date(now.getTime() - TYPICAL_RETENTION_MS) } },
  });
  return count;
}
