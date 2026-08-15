/**
 * Typical occupancy writer.
 *
 * Every 15 minutes we persist what each venue is *usually* like at this
 * Atlanta hour — day-part curves, not a nightlife sine wave, and never
 * labeled Live. Door scans / user reports / host parties remain the only
 * Live occupancy sources.
 */

import { db } from '../lib/db';
import { crowdEmitter } from '../routes/venues';
import { getRedis } from '../lib/redis';
import { runCrowdAlerts } from './crowdAlerts';
import {
  TYPICAL_LABELS,
  typicalJitter,
  typicalLevel,
  typicalWaitMins,
  TYPICAL_SOURCE,
} from './typicalOccupancy';

export interface SimulationResult {
  venuesUpdated: number;
  simulatedAt: string;
}

function atlantaClock(now = new Date()): { hour: number; day: number } {
  const et = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  return { hour: et.getHours(), day: et.getDay() };
}

export async function runCrowdSimulation(): Promise<SimulationResult> {
  const now = new Date();
  const { hour, day } = atlantaClock(now);

  const venues = await db.venue.findMany({ select: { id: true, slug: true, category: true } });

  const inserts = venues.map((v) => {
    const level = typicalJitter(typicalLevel(hour, day, v.category), v.slug ?? v.id, hour, day);
    return {
      venueId: v.id,
      level,
      label: TYPICAL_LABELS[level],
      waitMins: typicalWaitMins(level),
      source: TYPICAL_SOURCE,
      recordedAt: now,
    };
  });

  await db.crowdLevel.createMany({ data: inserts });

  const redis = getRedis();
  if (redis) {
    await redis.del('venues:all').catch(() => {});
  }

  for (const rec of inserts) {
    crowdEmitter.emit('crowd-update', {
      venueId: rec.venueId,
      crowd: {
        level: rec.level,
        label: rec.label,
        waitMins: rec.waitMins,
        source: rec.source,
        recordedAt: now.toISOString(),
      },
    });
  }

  console.log(`[crowd-sim] Wrote ${inserts.length} typical occupancy rows (ET hour=${hour}, day=${day})`);

  try {
    const alertResult = await runCrowdAlerts();
    if (alertResult.alertsSent > 0) {
      console.log(`[crowd-sim] Triggered ${alertResult.alertsSent} live occupancy alerts`);
    }
  } catch (err: any) {
    console.error('[crowd-sim] crowd alerts failed:', err?.message);
  }

  return { venuesUpdated: inserts.length, simulatedAt: now.toISOString() };
}

/** Start the in-process 15-minute typical-occupancy loop */
export function startCrowdSimulator(): void {
  const INTERVAL_MS = 15 * 60 * 1000;

  const run = async () => {
    try {
      const result = await runCrowdSimulation();
      console.log(`[crowd-sim] Done — updated ${result.venuesUpdated} venues`);
    } catch (err: any) {
      console.error('[crowd-sim] error:', err?.message);
    }
  };

  setTimeout(run, 30_000);
  setInterval(run, INTERVAL_MS);

  console.log('[crowd-sim] Typical occupancy writer started — first run in 30s, then every 15 min');
}
