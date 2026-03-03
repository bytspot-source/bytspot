import { Router } from 'express';
import { db } from '../lib/db';
import { getRedis } from '../lib/redis';
import { config } from '../config';
import { sendPushToAll } from './push';

const router = Router();

/** Redis key holding previous crowd level per venue: crowd:prev:{venueId} */
const prevKey = (venueId: string) => `crowd:prev:${venueId}`;

/**
 * POST /cron/crowd-alerts
 *
 * Called by the Render cron job every 15 minutes.
 * Protected by Bearer token matching CRON_SECRET env var.
 *
 * Logic:
 *  - Fetch all venues + their latest crowd level from Postgres
 *  - Compare each level to the previous level cached in Redis
 *  - If level just hit 4 (Packed) → push "🔴 {venue} is Packed"
 *  - If level was 4 and dropped to ≤ 2 (Active/Chill) → push "🟢 Spot opened up at {venue}"
 *  - Save new levels to Redis for next run
 */
router.post('/cron/crowd-alerts', async (req, res) => {
  // ── Auth ──────────────────────────────────────────
  const auth = req.headers['authorization'] || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (token !== config.cronSecret) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const redis = getRedis();
  const alerts: { venue: string; type: string }[] = [];

  try {
    // ── Fetch latest crowd level per venue ────────────
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

      // Read previous level from Redis (or memory fallback map)
      if (redis) {
        const cached = await redis.get(prevKey(venue.id)).catch(() => null);
        if (cached !== null) prevLevel = parseInt(cached, 10);
      }

      // ── Transition: anything → Packed (4) ─────────
      if (currentLevel >= 4 && (prevLevel === null || prevLevel < 4)) {
        await sendPushToAll(
          '🔴 Packed Alert — Bytspot',
          `${venue.name} just hit Packed. Check it out or find alternatives nearby.`,
          { venueId: venue.id, type: 'packed', url: 'https://beta.bytspot.com' }
        ).catch(() => {});
        alerts.push({ venue: venue.name, type: 'packed' });
      }

      // ── Transition: Packed → Active/Chill (≤ 2) ───
      if (prevLevel !== null && prevLevel >= 4 && currentLevel <= 2) {
        await sendPushToAll(
          '🟢 Your Spot Opened Up — Bytspot',
          `${venue.name} just dropped to ${current.label}. Head over now!`,
          { venueId: venue.id, type: 'opened-up', url: 'https://beta.bytspot.com' }
        ).catch(() => {});
        alerts.push({ venue: venue.name, type: 'opened-up' });
      }

      // ── Save current level for next run ────────────
      if (redis) {
        // Expire in 20 min (a bit longer than the 15-min cron interval)
        await redis.set(prevKey(venue.id), String(currentLevel), 'EX', 1200).catch(() => {});
      }
    }

    res.json({
      ok: true,
      venuesChecked: venues.length,
      alertsSent: alerts.length,
      alerts,
      checkedAt: new Date().toISOString(),
    });
  } catch (err: any) {
    console.error('[cron/crowd-alerts] error:', err?.message);
    res.status(500).json({ error: 'Internal error', detail: err?.message });
  }
});

export default router;

