import { Router } from 'express';

const router = Router();

/**
 * GET /rides?lat=33.78&lng=-84.38
 *
 * Legacy REST endpoint. It intentionally never presents simulated provider
 * estimates; premium mobility now requires the authenticated tRPC flow.
 */
router.get('/rides', async (req, res) => {
  const lat = parseFloat(req.query.lat as string);
  const lng = parseFloat(req.query.lng as string);

  if (isNaN(lat) || isNaN(lng)) {
    res.status(400).json({ error: 'lat and lng query params required' });
    return;
  }

  res.status(410).json({
    error: 'Ride estimates are no longer served by this endpoint.',
    message: 'Use authenticated premium mobility handoff for authorized destinations.',
  });
});

export default router;
