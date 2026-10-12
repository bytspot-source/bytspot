import { Router, type Response } from 'express';
import { captureError } from '../lib/observability';
import { requireCapability, requireVendorSeat } from '../middleware/vendorAuth';
import { activateBand, activateBandInput, BandRefused, editBand, editBandInput, listBands, markBandLost } from '../vendor/bands';

const router = Router();

/** Bands are set up like patches, so they need PUBLISH too. */
const canManage = requireCapability('PUBLISH');

function refuse(res: Response, err: unknown, route: string): void {
  if (err instanceof BandRefused) {
    res.status(err.status).json({ error: 'Band refused', blockers: err.blockers });
    return;
  }
  captureError(err, { route });
  res.status(500).json({ error: 'Internal error' });
}

router.get('/vendor/bands', requireVendorSeat, canManage, async (req, res) => {
  try {
    res.status(200).json({ bands: await listBands(req.vendor!.seller.id) });
  } catch (err) {
    refuse(res, err, 'vendor/bands:get');
  }
});

router.post('/vendor/bands/activate', requireVendorSeat, canManage, async (req, res) => {
  const parsed = activateBandInput.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid band', blockers: ['Enter the band number, choose a place and a tier'] });
    return;
  }
  try {
    const { seller, seat } = req.vendor!;
    res.status(200).json(await activateBand(seller.id, seat.id, parsed.data));
  } catch (err) {
    refuse(res, err, 'vendor/bands:activate');
  }
});

router.post('/vendor/bands/:id', requireVendorSeat, canManage, async (req, res) => {
  const parsed = editBandInput.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid band', blockers: ['Change the place, the tier or the code'] });
    return;
  }
  try {
    res.status(200).json({ band: await editBand(req.vendor!.seller.id, String(req.params.id), parsed.data) });
  } catch (err) {
    refuse(res, err, 'vendor/bands:edit');
  }
});

router.post('/vendor/bands/:id/lost', requireVendorSeat, canManage, async (req, res) => {
  try {
    res.status(200).json({ band: await markBandLost(req.vendor!.seller.id, String(req.params.id)) });
  } catch (err) {
    refuse(res, err, 'vendor/bands:lost');
  }
});

export default router;
