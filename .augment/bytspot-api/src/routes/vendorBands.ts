import { Router, type Response } from 'express';
import { captureError } from '../lib/observability';
import { requireCapability, requireVendorSeat } from '../middleware/vendorAuth';
import {
  activateBand,
  activateBandInput,
  BandRefused,
  editBand,
  editBandInput,
  listBands,
  markBandLost,
  secureBand,
  secureBandInput,
} from '../vendor/bands';

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
    res.status(400).json({ error: 'Invalid band', blockers: ['Enter the number, choose its type and a place, and a tier for a band'] });
    return;
  }
  try {
    const { seller, seat } = req.vendor!;
    res.status(200).json(await activateBand(seller.id, seat.id, parsed.data));
  } catch (err) {
    refuse(res, err, 'vendor/bands:activate');
  }
});

/**
 * One round of turning on an item's fresh code. The phone relays the APDUs to
 * the chip and posts the answers back; the keys stay on the server.
 */
router.post('/vendor/bands/secure', requireVendorSeat, canManage, async (req, res) => {
  const parsed = secureBandInput.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid band', blockers: ['Tap the band, card, fob or tag on the phone'] });
    return;
  }
  try {
    res.status(200).json(await secureBand(req.vendor!.seller.id, parsed.data));
  } catch (err) {
    refuse(res, err, 'vendor/bands:secure');
  }
});

router.post('/vendor/bands/:id', requireVendorSeat, canManage, async (req, res) => {
  const parsed = editBandInput.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid band', blockers: ['Change the type, the place, the tier or the code'] });
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
