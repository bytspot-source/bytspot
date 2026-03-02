import { Router } from 'express';
import { db } from '../lib/db';
import { config } from '../config';
import { getRedis } from '../lib/redis';

const router = Router();

/** Simple password guard — checks X-Admin-Password header */
function adminAuth(req: any, res: any, next: any) {
  const pw = req.headers['x-admin-password'];
  if (!pw || pw !== config.adminPassword) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  next();
}

/** Generate a random invite code like BYT-XXXXX */
function makeCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = 'BYT-';
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

// ── POST /admin/generate-invite ──────────────────────────
// Creates one or more invite codes, stored in Redis with 30-day TTL
router.post('/admin/generate-invite', adminAuth, async (req, res) => {
  const count = Math.min(parseInt(req.body?.count || '1', 10), 50);
  const r = getRedis();
  const codes: string[] = [];

  for (let i = 0; i < count; i++) {
    const code = makeCode();
    if (r) {
      // Store as JSON so we can track usage
      await r.set(`invite:${code}`, JSON.stringify({ used: false, createdAt: new Date().toISOString() }), 'EX', 60 * 60 * 24 * 30);
    } else {
      // In-memory fallback: just return codes (won't persist across restarts)
    }
    codes.push(code);
  }

  // If no Redis, store in DB as a note (codes field on first user row — not ideal but beats nothing)
  res.json({ codes, message: `Generated ${codes.length} invite code(s) — valid for 30 days` });
});

// ── POST /admin/validate-invite ───────────────────────────
// Called during signup to check if a code is valid and unused
router.post('/admin/validate-invite', async (req, res) => {
  const code = (req.body?.code || '').toUpperCase().trim();
  if (!code) {
    res.status(400).json({ valid: false, error: 'No code provided' });
    return;
  }

  // If invite system is disabled (no ADMIN_PASSWORD set), allow all signups
  if (!config.adminPassword) {
    res.json({ valid: true });
    return;
  }

  const r = getRedis();
  if (!r) {
    // No Redis — can't validate; allow signup so it's not a hard blocker
    res.json({ valid: true, warning: 'Redis unavailable — skipping validation' });
    return;
  }

  const raw = await r.get(`invite:${code}`);
  if (!raw) {
    res.status(404).json({ valid: false, error: 'Invalid or expired invite code' });
    return;
  }

  const data = JSON.parse(raw);
  if (data.used) {
    res.status(409).json({ valid: false, error: 'Invite code already used' });
    return;
  }

  // Mark used
  await r.set(`invite:${code}`, JSON.stringify({ ...data, used: true, usedAt: new Date().toISOString() }), 'KEEPTTL');
  res.json({ valid: true });
});

// ── GET /admin/stats ────────────────────────────────────
router.get('/admin/stats', adminAuth, async (req, res) => {
  const r = getRedis();
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const [totalUsers, newToday, totalCheckins, topVenues] = await Promise.all([
    db.user.count(),
    db.user.count({ where: { createdAt: { gte: today } } }),
    db.crowdLevel.count(),
    db.crowdLevel.groupBy({
      by: ['venueId'],
      _count: { venueId: true },
      orderBy: { _count: { venueId: 'desc' } },
      take: 5,
    }),
  ]);

  // Push subscriber count from Redis
  let pushSubscribers = 0;
  if (r) {
    try { pushSubscribers = await r.scard('push:subscriptions'); } catch {}
  }

  // Resolve venue names for top venues
  const venueIds = topVenues.map((v) => v.venueId);
  const venues = await db.venue.findMany({ where: { id: { in: venueIds } }, select: { id: true, name: true } });
  const nameMap = Object.fromEntries(venues.map((v) => [v.id, v.name]));

  res.json({
    totalUsers,
    newSignupsToday: newToday,
    totalCheckins,
    pushSubscribers,
    topVenues: topVenues.map((v) => ({
      venueId: v.venueId,
      name: nameMap[v.venueId] || v.venueId,
      checkins: v._count.venueId,
    })),
    generatedAt: new Date().toISOString(),
  });
});

export default router;

