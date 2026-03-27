/**
 * Crowd Simulator Service
 *
 * Generates realistic, time-aware crowd level data for all venues every
 * 15 minutes so the app always shows fresh data. Levels follow a
 * realistic daily curve:
 *   - 6am–11am:  building up (1→2)
 *   - 11am–2pm:  lunch rush (2→3)
 *   - 2pm–5pm:   afternoon lull (2)
 *   - 5pm–9pm:   evening peak (3→4)
 *   - 9pm–1am:   nightlife peak for bars/clubs (3→4), winding down for others
 *   - 1am–6am:   dead (1)
 *
 * Each venue gets slight randomness layered on top of the curve, and
 * weekends (Fri/Sat) shift everything up by ~1 level in the evening.
 */

import { db } from '../lib/db';
import { crowdEmitter } from '../routes/venues';
import { cached, getRedis } from '../lib/redis';
import { runCrowdAlerts } from './crowdAlerts';

const LABELS: Record<number, string> = { 1: 'Chill', 2: 'Active', 3: 'Busy', 4: 'Packed' };

/** Category-specific modifiers: bars/clubs peak later, restaurants peak at meals */
const CATEGORY_OFFSETS: Record<string, { peakHour: number; intensity: number }> = {
  bar:        { peakHour: 22, intensity: 1.2 },
  club:       { peakHour: 23, intensity: 1.3 },
  restaurant: { peakHour: 19, intensity: 1.0 },
  park:       { peakHour: 14, intensity: 0.7 },
  market:     { peakHour: 12, intensity: 0.9 },
};

function getBaseLevel(hour: number, dayOfWeek: number, category: string): number {
  const { peakHour, intensity } = CATEGORY_OFFSETS[category] || { peakHour: 20, intensity: 1.0 };
  const isWeekendEvening = (dayOfWeek === 5 || dayOfWeek === 6) && hour >= 17;

  // Distance from peak hour (wrapping at 24)
  let dist = Math.abs(hour - peakHour);
  if (dist > 12) dist = 24 - dist;

  // Base crowd from gaussian-ish curve around peak
  let base: number;
  if (dist <= 1) base = 4;
  else if (dist <= 3) base = 3;
  else if (dist <= 5) base = 2;
  else base = 1;

  // Dead hours override
  if (hour >= 2 && hour <= 6) base = 1;

  // Apply category intensity
  base = Math.round(base * intensity);

  // Weekend boost
  if (isWeekendEvening) base = Math.min(base + 1, 4);

  return Math.max(1, Math.min(4, base));
}

/** Add controlled randomness: ±1 with 30% probability */
function jitter(level: number): number {
  const r = Math.random();
  if (r < 0.15) return Math.max(1, level - 1);
  if (r > 0.85) return Math.min(4, level + 1);
  return level;
}

export interface SimulationResult {
  venuesUpdated: number;
  simulatedAt: string;
}

export async function runCrowdSimulation(): Promise<SimulationResult> {
  const now = new Date();
  // Use Eastern Time for Atlanta
  const etHour = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' })).getHours();
  const etDay = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' })).getDay();

  const venues = await db.venue.findMany({ select: { id: true, category: true } });

  const inserts = venues.map((v) => {
    const level = jitter(getBaseLevel(etHour, etDay, v.category));
    return {
      venueId: v.id,
      level,
      label: LABELS[level],
      waitMins: level <= 1 ? 0 : level * 5 + Math.floor(Math.random() * 5),
      source: 'simulation',
      recordedAt: now,
    };
  });

  // Batch insert all crowd levels
  await db.crowdLevel.createMany({ data: inserts });

  // Invalidate the venues cache so the next API call picks up fresh data
  const redis = getRedis();
  if (redis) {
    await redis.del('venues:all').catch(() => {});
  }

  // Emit SSE updates for each venue so connected clients get real-time pushes
  for (const rec of inserts) {
    crowdEmitter.emit('crowd-update', {
      venueId: rec.venueId,
      crowd: {
        level: rec.level,
        label: rec.label,
        waitMins: rec.waitMins,
        recordedAt: now.toISOString(),
      },
    });
  }

  console.log(`[crowd-sim] Generated ${inserts.length} crowd updates (ET hour=${etHour}, day=${etDay})`);

  // Chain crowd alerts immediately after new data is written so transitions are detected
  try {
    const alertResult = await runCrowdAlerts();
    if (alertResult.alertsSent > 0) {
      console.log(`[crowd-sim] Triggered ${alertResult.alertsSent} crowd alerts`);
    }
  } catch (err: any) {
    console.error('[crowd-sim] crowd alerts failed:', err?.message);
  }

  return { venuesUpdated: inserts.length, simulatedAt: now.toISOString() };
}

/** Start the in-process 15-minute crowd simulation loop */
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

  // First run 30s after server start (quick warm-up)
  setTimeout(run, 30_000);
  // Then every 15 minutes
  setInterval(run, INTERVAL_MS);

  console.log('[crowd-sim] Simulator started — first run in 30s, then every 15 min');
}

