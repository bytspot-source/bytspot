import { Router } from 'express';
import { cached } from '../lib/redis';

const router = Router();

/**
 * GET /rides?lat=33.78&lng=-84.38
 *
 * Returns live ride provider availability when a provider integration is configured.
 */
router.get('/rides', async (req, res) => {
  const lat = parseFloat(req.query.lat as string);
  const lng = parseFloat(req.query.lng as string);

  if (isNaN(lat) || isNaN(lng)) {
    res.status(400).json({ error: 'lat and lng query params required' });
    return;
  }

  const cacheKey = `rides:${lat.toFixed(3)}:${lng.toFixed(3)}`;

  const rides = await cached(cacheKey, 60, async () => {
    return {
      location: { lat, lng },
      timestamp: new Date().toISOString(),
      providers: [],
      source: 'unavailable',
    };
  });

  res.json(rides);
});

export default router;
