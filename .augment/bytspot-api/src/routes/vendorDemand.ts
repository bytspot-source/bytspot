import { Router } from 'express';
import { captureError } from '../lib/observability';
import { requireCapability, requireVendorSeat } from '../middleware/vendorAuth';
import {
  DemandMoved,
  NoCapacity,
  NotFound,
  buildDemandSnapshot,
  respondInput,
  respondToDemand,
} from '../vendor/demandFeed';

/**
 * The vendor console's two endpoints. Both are thin: the feed and the answer
 * live in ../vendor/demandFeed so they can be exercised against a real
 * database rather than only through HTTP.
 */
const router = Router();

router.get('/vendor/demand', requireVendorSeat, async (req, res) => {
  try {
    res.status(200).json(await buildDemandSnapshot(req.vendor!.seller.id, req.vendor!.locations, new Date()));
  } catch (err) {
    captureError(err, { route: 'vendor/demand:get' });
    res.status(500).json({ error: 'Internal error' });
  }
});

router.post('/vendor/demand/:id/respond', requireVendorSeat, requireCapability('SELL'), async (req, res) => {
  const parsed = respondInput.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid response', blockers: ['Choose what to offer first'] });
    return;
  }

  const demandId = String(req.params.id ?? '');
  if (!demandId) {
    res.status(404).json({ error: 'No such request' });
    return;
  }

  try {
    const seat = {
      sellerId: req.vendor!.seller.id,
      seatId: req.vendor!.seat.id,
      capabilities: req.vendor!.capabilities,
      locations: req.vendor!.locations,
    };
    res.status(200).json(await respondToDemand(seat, demandId, parsed.data));
  } catch (err) {
    if (err instanceof NotFound) {
      res.status(404).json({ error: err.what === 'request' ? 'No such request' : 'No such offering' });
      return;
    }
    if (err instanceof DemandMoved) {
      res.status(409).json({ error: 'Not available', blockers: ['That request has already moved on'] });
      return;
    }
    if (err instanceof NoCapacity) {
      res.status(409).json({ error: 'No capacity', blockers: ['That slot has gone since you looked'] });
      return;
    }
    captureError(err, { route: 'vendor/demand:respond' });
    res.status(500).json({ error: 'Internal error' });
  }
});

export default router;
