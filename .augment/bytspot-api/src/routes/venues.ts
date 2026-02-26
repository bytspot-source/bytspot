import { Router } from 'express';
import { db } from '../lib/db';
import { cached } from '../lib/redis';

const router = Router();

/** GET /venues — list all venues with latest crowd level */
router.get('/venues', async (_req, res) => {
  const venues = await cached('venues:all', 30, async () => {
    const rows = await db.venue.findMany({
      include: {
        crowdLevels: {
          orderBy: { recordedAt: 'desc' },
          take: 1,
        },
        parking: true,
      },
      orderBy: { name: 'asc' },
    });

    return rows.map((v) => ({
      id: v.id,
      name: v.name,
      slug: v.slug,
      address: v.address,
      lat: v.lat,
      lng: v.lng,
      category: v.category,
      imageUrl: v.imageUrl,
      crowd: v.crowdLevels[0]
        ? {
            level: v.crowdLevels[0].level,
            label: v.crowdLevels[0].label,
            waitMins: v.crowdLevels[0].waitMins,
            recordedAt: v.crowdLevels[0].recordedAt,
          }
        : null,
      parking: {
        totalAvailable: v.parking.reduce((sum, p) => sum + p.available, 0),
        spots: v.parking.map((p) => ({
          name: p.name,
          type: p.type,
          available: p.available,
          total: p.totalSpots,
          pricePerHr: p.pricePerHr,
        })),
      },
    }));
  });

  res.json({ venues });
});

/** GET /venues/:slug — single venue detail */
router.get('/venues/:slug', async (req, res) => {
  const { slug } = req.params;

  const venue = await cached(`venue:${slug}`, 15, async () => {
    return db.venue.findUnique({
      where: { slug },
      include: {
        crowdLevels: {
          orderBy: { recordedAt: 'desc' },
          take: 24, // last 24 readings for trend chart
        },
        parking: true,
      },
    });
  });

  if (!venue) {
    res.status(404).json({ error: 'Venue not found' });
    return;
  }

  res.json({
    id: venue.id,
    name: venue.name,
    slug: venue.slug,
    address: venue.address,
    lat: venue.lat,
    lng: venue.lng,
    category: venue.category,
    imageUrl: venue.imageUrl,
    crowd: {
      current: venue.crowdLevels[0] || null,
      history: venue.crowdLevels,
    },
    parking: venue.parking.map((p) => ({
      name: p.name,
      type: p.type,
      available: p.available,
      total: p.totalSpots,
      pricePerHr: p.pricePerHr,
    })),
  });
});

export default router;
