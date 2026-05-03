import { Router } from 'express';
import { EventEmitter } from 'events';
import { db } from '../lib/db';
import { cached, getRedis } from '../lib/redis';
import {
  hasVenueTicketingColumns,
  mapPublicVenueCrowdSnapshot,
  mapPublicVenueDetail,
  mapPublicVenueSummary,
  publicVenueCheckinSelect,
  publicVenueCrowdSnapshotSelect,
  publicVenueDetailSelect,
  publicVenueDetailSelectWithTicketing,
  publicVenueListSelect,
  publicVenueListSelectWithTicketing,
} from '../lib/venuePublic';
import { sendPushToAll } from './push';
import { sendCrowdAlertEmail } from '../lib/email';

const router = Router();

// In-memory event emitter for SSE crowd updates
export const crowdEmitter = new EventEmitter();
crowdEmitter.setMaxListeners(200); // allow many concurrent SSE clients

/** GET /venues — list all venues with latest crowd level */
router.get('/venues', async (_req, res) => {
  const venues = await cached('venues:all', 30, async () => {
    const ticketingColumnsAvailable = await hasVenueTicketingColumns();
    const rows = ticketingColumnsAvailable
      ? await db.venue.findMany({
          select: publicVenueListSelectWithTicketing,
          orderBy: { name: 'asc' },
        })
      : await db.venue.findMany({
          select: publicVenueListSelect,
          orderBy: { name: 'asc' },
        });

    return rows.map(mapPublicVenueSummary);
  });

  res.json({ venues });
});

/** GET /venues/nearby?lat=&lng=&radius= — venues within radius (meters) */
router.get('/venues/nearby', async (req, res) => {
  const lat = parseFloat(req.query.lat as string);
  const lng = parseFloat(req.query.lng as string);
  const radius = parseInt(req.query.radius as string) || 2000; // default 2km

  if (isNaN(lat) || isNaN(lng)) {
    res.status(400).json({ error: 'lat and lng query params required' });
    return;
  }

  const cacheKey = `venues:nearby:${lat.toFixed(4)}:${lng.toFixed(4)}:${radius}`;
  const venues = await cached(cacheKey, 30, async () => {
    const rows = await db.$queryRawUnsafe<
      Array<{
        id: string;
        name: string;
        slug: string;
        address: string;
        lat: number;
        lng: number;
        category: string;
        image_url: string | null;
        distance: number;
      }>
    >(
      `SELECT id, name, slug, address, lat, lng, category, image_url,
              ST_Distance(location::geography, ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography) as distance
       FROM venues
       WHERE location IS NOT NULL
         AND ST_DWithin(location::geography, ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography, $3)
       ORDER BY distance ASC`,
      lng,
      lat,
      radius,
    );

    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      slug: r.slug,
      address: r.address,
      lat: r.lat,
      lng: r.lng,
      category: r.category,
      imageUrl: r.image_url,
      distanceMeters: Math.round(r.distance),
    }));
  });

  res.json({ venues });
});

/** GET /venues/:slug/similar?limit= — similar venues by AI embedding */
router.get('/venues/:slug/similar', async (req, res) => {
  const { slug } = req.params;
  const limit = Math.min(parseInt(req.query.limit as string) || 5, 20);

  const similar = await cached(`venues:similar:${slug}:${limit}`, 60, async () => {
    const rows = await db.$queryRawUnsafe<
      Array<{
        id: string;
        name: string;
        slug: string;
        category: string;
        similarity: number;
      }>
    >(
      `SELECT v2.id, v2.name, v2.slug, v2.category,
              1 - (v1.embedding <=> v2.embedding) as similarity
       FROM venues v1
       CROSS JOIN venues v2
       WHERE v1.slug = $1
         AND v2.slug != $1
         AND v1.embedding IS NOT NULL
         AND v2.embedding IS NOT NULL
       ORDER BY v1.embedding <=> v2.embedding
       LIMIT $2`,
      slug,
      limit,
    );

    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      slug: r.slug,
      category: r.category,
      similarity: parseFloat(Number(r.similarity).toFixed(4)),
    }));
  });

  res.json({ similar });
});

/** GET /venues/:slug — single venue detail */
router.get('/venues/:slug', async (req, res) => {
  const { slug } = req.params;
  const ticketingColumnsAvailable = await hasVenueTicketingColumns();

  const venue = await cached(`venue:${slug}`, 15, async () => {
    return ticketingColumnsAvailable
      ? db.venue.findUnique({
          where: { slug },
          select: publicVenueDetailSelectWithTicketing,
        })
      : db.venue.findUnique({
          where: { slug },
          select: publicVenueDetailSelect,
        });
  });

  if (!venue) {
    res.status(404).json({ error: 'Venue not found' });
    return;
  }

  res.json(mapPublicVenueDetail(venue));
});

/** GET /venues/crowd/stream — SSE stream of live crowd updates */
router.get('/venues/crowd/stream', async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // disable Nginx buffering on Render
  res.flushHeaders();

  // Send initial snapshot so client has data immediately
  try {
    const rows = await db.venue.findMany({
      select: publicVenueCrowdSnapshotSelect,
      orderBy: { name: 'asc' },
    });
    const snapshot = rows.map(mapPublicVenueCrowdSnapshot);
    res.write(`data: ${JSON.stringify({ type: 'snapshot', venues: snapshot })}\n\n`);
  } catch { /* skip if DB down */ }

  // Push individual crowd updates to this client
  const onUpdate = (update: object) => {
    res.write(`data: ${JSON.stringify({ type: 'update', ...update })}\n\n`);
  };
  crowdEmitter.on('crowd-update', onUpdate);

  // Heartbeat every 25s to keep connection alive through proxies
  const heartbeat = setInterval(() => { res.write(': ping\n\n'); }, 25_000);

  req.on('close', () => {
    clearInterval(heartbeat);
    crowdEmitter.off('crowd-update', onUpdate);
  });
});

/** POST /venues/:id/checkin — user contributes crowd data (idempotent) */
router.post('/venues/:id/checkin', async (req, res) => {
  const { id } = req.params;
  const iKey = req.headers['idempotency-key'] as string | undefined;

  // ── Idempotency: replay cached result if we've seen this key before ──
  if (iKey) {
    const r = getRedis();
    if (r) {
      try {
        const cached = await r.get(`idem:checkin:${iKey}`);
        if (cached) {
          res.json(JSON.parse(cached)); // exact same response, no DB write
          return;
        }
      } catch { /* Redis miss — continue to real handler */ }
    }
  }

  const venue = await db.venue.findUnique({ where: { id }, select: publicVenueCheckinSelect });
  if (!venue) {
    res.status(404).json({ error: 'Venue not found' });
    return;
  }

  // Get latest crowd level to base new reading on
  const latest = await db.crowdLevel.findFirst({
    where: { venueId: id },
    orderBy: { recordedAt: 'desc' },
  });

  // Nudge level up by 1 (max 4) — checkin signals it's busier
  const newLevel = Math.min((latest?.level ?? 1) + 1, 4);
  const labels: Record<number, string> = { 1: 'Chill', 2: 'Active', 3: 'Busy', 4: 'Packed' };

  await db.crowdLevel.create({
    data: {
      venueId: id,
      level: newLevel,
      label: labels[newLevel],
      waitMins: newLevel * 5,
      source: 'user_report',
    },
  });

  // Broadcast to all SSE clients
  crowdEmitter.emit('crowd-update', {
    venueId: id,
    crowd: { level: newLevel, label: labels[newLevel], waitMins: newLevel * 5, recordedAt: new Date().toISOString() },
  });

  const result = { success: true, newCrowdLevel: newLevel };

  // ── Push + email when venue flips to "Packed" ──
  if (newLevel === 4) {
    sendPushToAll(
      `🔴 ${venue.name} is now Packed`,
      `High crowd at ${venue.name} — plan ahead or find somewhere chill nearby.`,
      { venueId: id, venueName: venue.name, type: 'packed-alert' },
    ).catch(() => {}); // non-blocking, fire-and-forget

    // Email users who have this venue saved (best-effort — requires savedSpots on user model)
    // For now we notify all users as a crowd alert broadcast (can scope to saved spots later)
    db.user.findMany({ select: { email: true, name: true } })
      .then((users) => {
        for (const u of users) {
          if (u.email) {
            const firstName = (u.name || '').split(' ')[0];
            sendCrowdAlertEmail(u.email, firstName, venue.name, venue.slug || id).catch(() => {});
          }
        }
      })
      .catch(() => {});
  }

  // ── Cache result for 24 h so any retries with the same key replay it ──
  if (iKey) {
    const r = getRedis();
    if (r) r.set(`idem:checkin:${iKey}`, JSON.stringify(result), 'EX', 86400).catch(() => {});
  }

  res.json(result);
});

export default router;
