import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { captureError } from '../lib/observability';
import { requireCapability, requireVendorSeat } from '../middleware/vendorAuth';
import { roleScope, type SeatRole } from '../vendor/contract';
import { BandRefused, linkBand, readBand } from '../vendor/bands';
import {
  BookingNotFound,
  BookingRefused,
  bookingsWhen,
  findByPass,
  listBookings,
  moveBooking,
  normalizePassCode,
  type BookingOperation,
} from '../vendor/bookings';

const router = Router();

/** An assigned-scope seat sees only the bookings on the windows named on it. */
function scopedWindows(req: Request): string[] | undefined {
  const { seat } = req.vendor!;
  return roleScope(seat.role as SeatRole) === 'assigned' ? seat.bookableIds : undefined;
}

router.get('/vendor/bookings', requireVendorSeat, async (req, res) => {
  try {
    const bookings = await listBookings({
      sellerId: req.vendor!.seller.id,
      when: bookingsWhen(req.query.when),
      windowIds: scopedWindows(req),
    });
    res.status(200).json({ bookings });
  } catch (err) {
    captureError(err, { route: 'vendor/bookings:get' });
    res.status(500).json({ error: 'Internal error' });
  }
});

const bookingMove = z.object({ operation: z.enum(['CHECK_IN', 'NO_SHOW']) });

/** Checks a guest in, or records that they did not come. */
router.post('/vendor/bookings/:id/state', requireVendorSeat, requireCapability('CHECK_IN'), async (req, res) => {
  const parsed = bookingMove.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid operation', blockers: ['Pick check in or no-show'] });
    return;
  }
  const { seller, seat } = req.vendor!;
  try {
    const booking = await moveBooking({
      sellerId: seller.id,
      offerId: String(req.params.id ?? ''),
      seatId: seat.id,
      operation: parsed.data.operation as BookingOperation,
      windowIds: scopedWindows(req),
    });
    res.status(200).json({ booking });
  } catch (err) {
    if (err instanceof BookingNotFound) {
      res.status(404).json({ error: 'No such booking', blockers: ['That booking is not here'] });
      return;
    }
    if (err instanceof BookingRefused) {
      res.status(409).json({ error: 'Booking refused', blockers: err.blockers });
      return;
    }
    captureError(err, { route: 'vendor/bookings:state' });
    res.status(500).json({ error: 'Internal error' });
  }
});

const passCheck = z.object({ code: z.string().max(80) });

/** Reads a pass without changing it. Checking in is a separate, explicit step. */
router.post('/vendor/passes/verify', requireVendorSeat, requireCapability('VERIFY'), async (req, res) => {
  const parsed = passCheck.safeParse(req.body);
  const code = parsed.success ? normalizePassCode(parsed.data.code) : undefined;
  if (!code) {
    res.status(400).json({ error: 'Invalid pass', blockers: ['A pass code is 8 letters and numbers'] });
    return;
  }
  try {
    const booking = await findByPass({ sellerId: req.vendor!.seller.id, code, windowIds: scopedWindows(req) });
    if (!booking) {
      res.status(404).json({ error: 'Unknown pass', blockers: ['No booking here has that pass'] });
      return;
    }
    res.status(200).json({ booking });
  } catch (err) {
    captureError(err, { route: 'vendor/passes:verify' });
    res.status(500).json({ error: 'Internal error' });
  }
});

const bandCheck = z.object({ band: z.string().trim().min(1).max(300) });
const bandLink = bandCheck.extend({ bookingId: z.string().trim().min(1).max(64) });

function refuseBand(res: Response, err: unknown, route: string): void {
  if (err instanceof BandRefused) {
    res.status(err.status).json({ error: 'Band refused', blockers: err.blockers });
    return;
  }
  captureError(err, { route });
  res.status(500).json({ error: 'Internal error' });
}

/** Bands find tickets, which hang off no window, so an assigned-scope seat has nothing to find. */
const BAND_SCOPE_REFUSED = { error: 'Not permitted', blockers: ['Your role checks in bookings for your own services only'] };

/** Reads a tapped or scanned band, and the ticket its guest holds for now. Changes nothing. */
router.post('/vendor/passes/band', requireVendorSeat, requireCapability('VERIFY'), async (req, res) => {
  const parsed = bandCheck.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid band', blockers: ['Tap the band, scan its code or type its number'] });
    return;
  }
  if (scopedWindows(req)) {
    res.status(403).json(BAND_SCOPE_REFUSED);
    return;
  }
  try {
    res.status(200).json(await readBand(req.vendor!.seller.id, parsed.data.band));
  } catch (err) {
    refuseBand(res, err, 'vendor/passes:band');
  }
});

/** Links a band to the guest whose paid ticket was just scanned. */
router.post('/vendor/passes/band/link', requireVendorSeat, requireCapability('CHECK_IN'), async (req, res) => {
  const parsed = bandLink.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid band', blockers: ['Scan the ticket, then tap the band'] });
    return;
  }
  if (scopedWindows(req)) {
    res.status(403).json(BAND_SCOPE_REFUSED);
    return;
  }
  const { seller, seat } = req.vendor!;
  try {
    res.status(200).json({ band: await linkBand({ sellerId: seller.id, seatId: seat.id, ...parsed.data }) });
  } catch (err) {
    refuseBand(res, err, 'vendor/passes:band-link');
  }
});

export default router;
