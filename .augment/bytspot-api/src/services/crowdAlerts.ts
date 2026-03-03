/**
 * Crowd Alert Service
 *
 * Checks crowd levels across all venues every 15 minutes and sends
 * push notifications for two key transitions:
 *   1. Venue just hit Packed (level ≥ 4)  → alert all subscribers
 *   2. Venue dropped from Packed to Active/Chill (level ≤ 2) → "spot opened up" alert
 *
 * Previous levels are cached in Redis (or skipped on first run).
 */

import { db } from '../lib/db';
import { getRedis } from '../lib/redis';
import { sendPushToAll } from '../routes/push';

const prevKey = (venueId: string) => `crowd:prev:${venueId}`;

export interface CrowdAlertResult {
  venuesChecked: number;
  alertsSent: number;
  alerts: { venue: string; type: string }[];
  checkedAt: string;
}

export async function runCrowdAlerts(): Promise<CrowdAlertResult> {
  const redis = getRedis();
  const alerts: { venue: string; type: string }[] = [];

  const venues = await db.venue.findMany({
    select: {
      id: true,
      name: true,
      crowdLevels: {
        orderBy: { recordedAt: 'desc' },
        take: 1,
        select: { level: true, label: true },
      },
    },
  });

  for (const venue of venues) {
    const current = venue.crowdLevels[0];
    if (!current) continue;

    const currentLevel = current.level;
    let prevLevel: number | null = null;

    if (redis) {
      const cached = await redis.get(prevKey(venue.id)).catch(() => null);
      if (cached !== null) prevLevel = parseInt(cached, 10);
    }

    // ── Transition: any → Packed ─────────────────────
    if (currentLevel >= 4 && (prevLevel === null || prevLevel < 4)) {
      await sendPushToAll(
        '🔴 Packed Alert — Bytspot',
        `${venue.name} just hit Packed. Check it out or find alternatives nearby.`,
        { venueId: venue.id, type: 'packed', url: 'https://beta.bytspot.com' },
      ).catch(() => {});
      alerts.push({ venue: venue.name, type: 'packed' });
      console.log(`[crowd-alerts] Packed alert sent for ${venue.name}`);
    }

    // ── Transition: Packed → Active/Chill ────────────
    if (prevLevel !== null && prevLevel >= 4 && currentLevel <= 2) {
      await sendPushToAll(
        '🟢 Your Spot Opened Up — Bytspot',
        `${venue.name} just dropped to ${current.label}. Head over now!`,
        { venueId: venue.id, type: 'opened-up', url: 'https://beta.bytspot.com' },
      ).catch(() => {});
      alerts.push({ venue: venue.name, type: 'opened-up' });
      console.log(`[crowd-alerts] Opened-up alert sent for ${venue.name}`);
    }

    // ── Persist current level ─────────────────────────
    if (redis) {
      await redis.set(prevKey(venue.id), String(currentLevel), 'EX', 1200).catch(() => {});
    }
  }

  return {
    venuesChecked: venues.length,
    alertsSent: alerts.length,
    alerts,
    checkedAt: new Date().toISOString(),
  };
}

/** Start the in-process 15-minute crowd alert loop */
export function startCrowdAlertScheduler(): void {
  const INTERVAL_MS = 15 * 60 * 1000; // 15 minutes

  const run = async () => {
    try {
      console.log('[crowd-alerts] Running scheduled check…');
      const result = await runCrowdAlerts();
      console.log(`[crowd-alerts] Done — checked ${result.venuesChecked} venues, sent ${result.alertsSent} alerts`);
    } catch (err: any) {
      console.error('[crowd-alerts] scheduler error:', err?.message);
    }
  };

  // First run 2 minutes after server start (let server warm up)
  setTimeout(run, 2 * 60 * 1000);
  // Then every 15 minutes
  setInterval(run, INTERVAL_MS);

  console.log('[crowd-alerts] Scheduler started — first run in 2 min, then every 15 min');
}

