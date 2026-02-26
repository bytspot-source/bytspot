import { Router } from 'express';
import { cached } from '../lib/redis';

const router = Router();

/**
 * GET /rides?lat=33.78&lng=-84.38
 *
 * Phase 1: Returns mock ride data shaped like the real Uber/Lyft APIs.
 * Phase 2+: Will call actual Uber & Lyft APIs via RideHub namespace.
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
    // ── Mock data for Phase 1 ──
    // Simulates realistic Midtown Atlanta ride pricing
    const basePrice = 8 + Math.random() * 6; // $8-14 base
    const surgeMultiplier = isFridaySaturday() ? 1.2 + Math.random() * 0.8 : 1.0;

    return {
      location: { lat, lng },
      timestamp: new Date().toISOString(),
      providers: [
        {
          name: 'Uber',
          products: [
            {
              type: 'UberX',
              etaMinutes: Math.floor(3 + Math.random() * 5),
              priceEstimate: `$${(basePrice * surgeMultiplier).toFixed(2)}`,
              surgeMultiplier: parseFloat(surgeMultiplier.toFixed(1)),
            },
            {
              type: 'Uber Comfort',
              etaMinutes: Math.floor(5 + Math.random() * 7),
              priceEstimate: `$${(basePrice * surgeMultiplier * 1.4).toFixed(2)}`,
              surgeMultiplier: parseFloat(surgeMultiplier.toFixed(1)),
            },
          ],
        },
        {
          name: 'Lyft',
          products: [
            {
              type: 'Lyft',
              etaMinutes: Math.floor(3 + Math.random() * 6),
              priceEstimate: `$${(basePrice * surgeMultiplier * 0.95).toFixed(2)}`,
              surgeMultiplier: parseFloat((surgeMultiplier * 0.95).toFixed(1)),
            },
            {
              type: 'Lyft XL',
              etaMinutes: Math.floor(6 + Math.random() * 8),
              priceEstimate: `$${(basePrice * surgeMultiplier * 1.6).toFixed(2)}`,
              surgeMultiplier: parseFloat(surgeMultiplier.toFixed(1)),
            },
          ],
        },
      ],
    };
  });

  res.json(rides);
});

function isFridaySaturday(): boolean {
  const day = new Date().getDay();
  return day === 5 || day === 6; // Friday or Saturday
}

export default router;
