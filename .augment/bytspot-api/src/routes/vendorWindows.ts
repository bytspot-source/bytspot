import { Router, type Request, type Response } from 'express';
import { captureError } from '../lib/observability';
import { requireCapability, requireVendorSeat } from '../middleware/vendorAuth';
import { allowedBookableTypes, roleScope, type SeatRole, type SellerState } from '../vendor/contract';
import { NotFound } from '../vendor/demandFeed';
import { seatCanSeeBookable, seatCanSeeLocation } from '../vendor/media';
import { WindowRefused, createWindow, createWindowInput, listWindows, setWindowPublished } from '../vendor/windows';
import { moveSlot, scheduleWrite, slotWrite, updateSchedule, windowSlots, type SlotOperationId } from '../vendor/slots';

const router = Router();

router.get('/vendor/windows', requireVendorSeat, async (req, res) => {
  const { seller, seat } = req.vendor!;
  try {
    // An assigned-scope seat sees only the windows named on it.
    const scoped = roleScope(seat.role as SeatRole) === 'assigned' ? seat.bookableIds : undefined;
    res.status(200).json({ windows: await listWindows(seller.id, scoped) });
  } catch (err) {
    captureError(err, { route: 'vendor/windows:get' });
    res.status(500).json({ error: 'Internal error' });
  }
});

router.post('/vendor/windows', requireVendorSeat, requireCapability('SCHEDULE'), async (req, res) => {
  const parsed = createWindowInput.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid window', blockers: ['Pick what you sell, where, and when'] });
    return;
  }

  const { seller, seat, locations } = req.vendor!;
  const role = seat.role as SeatRole;
  // A new window is new inventory, so a seat scoped to assigned bookables
  // cannot mint one it would then be the only one able to see.
  if (roleScope(role) === 'assigned' || !seatCanSeeLocation(role, seat.locationIds, parsed.data.locationId)) {
    res.status(403).json({ error: 'Not permitted', blockers: ['Your role cannot do that'] });
    return;
  }

  try {
    const allowed = allowedBookableTypes(seller.businessKind, seller.extraBookableTypes);
    res.status(201).json(await createWindow(seller.id, locations, parsed.data, allowed));
  } catch (err) {
    if (err instanceof WindowRefused) {
      res.status(422).json({ error: 'Window refused', blockers: err.blockers });
      return;
    }
    captureError(err, { route: 'vendor/windows:post' });
    res.status(500).json({ error: 'Internal error' });
  }
});

function publishHandler(published: boolean) {
  return async (req: Request, res: Response): Promise<void> => {
    const windowId = String(req.params.id ?? '');
    const { seller, seat } = req.vendor!;
    if (!windowId || !seatCanSeeBookable(seat.role as SeatRole, seat.bookableIds, windowId)) {
      res.status(404).json({ error: 'No such offering' });
      return;
    }

    try {
      res.status(200).json(
        await setWindowPublished({
          sellerId: seller.id,
          sellerState: seller.state as SellerState,
          windowId,
          published,
        }),
      );
    } catch (err) {
      if (err instanceof NotFound) {
        res.status(404).json({ error: 'No such offering' });
        return;
      }
      if (err instanceof WindowRefused) {
        res.status(409).json({ error: 'Not ready to publish', blockers: err.blockers });
        return;
      }
      captureError(err, { route: published ? 'vendor/windows:publish' : 'vendor/windows:unpublish' });
      res.status(500).json({ error: 'Internal error' });
    }
  };
}

router.post('/vendor/windows/:id/publish', requireVendorSeat, requireCapability('PUBLISH'), publishHandler(true));
router.post('/vendor/windows/:id/unpublish', requireVendorSeat, requireCapability('PUBLISH'), publishHandler(false));

/** A bookable's derived slots for its horizon, with what is already taken. */
router.get('/vendor/windows/:id/slots', requireVendorSeat, async (req, res) => {
  const windowId = String(req.params.id ?? '');
  const { seller, seat } = req.vendor!;
  if (!seatCanSeeBookable(seat.role as SeatRole, seat.bookableIds, windowId)) {
    res.status(404).json({ error: 'No such offering' });
    return;
  }
  try {
    res.status(200).json(await windowSlots(seller.id, windowId));
  } catch (err) {
    if (err instanceof NotFound) {
      res.status(404).json({ error: 'No such offering' });
      return;
    }
    captureError(err, { route: 'vendor/windows:slots' });
    res.status(500).json({ error: 'Internal error' });
  }
});

/** Opens, closes or blocks one slot. Bookings already taken in it stand. */
router.post('/vendor/windows/:id/slots', requireVendorSeat, requireCapability('SCHEDULE'), async (req, res) => {
  const parsed = slotWrite.safeParse(req.body);
  const windowId = String(req.params.id ?? '');
  const { seller, seat } = req.vendor!;
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid slot', blockers: ['Pick a slot first'] });
    return;
  }
  if (!seatCanSeeBookable(seat.role as SeatRole, seat.bookableIds, windowId)) {
    res.status(404).json({ error: 'No such offering' });
    return;
  }
  try {
    res.status(200).json(
      await moveSlot({
        sellerId: seller.id,
        windowId,
        startsAt: new Date(parsed.data.startsAt),
        operation: parsed.data.operation as SlotOperationId,
        reason: parsed.data.reason,
      }),
    );
  } catch (err) {
    if (err instanceof NotFound) {
      res.status(404).json({ error: 'No such offering' });
      return;
    }
    if (err instanceof WindowRefused) {
      res.status(409).json({ error: 'Slot refused', blockers: err.blockers });
      return;
    }
    captureError(err, { route: 'vendor/windows:slot' });
    res.status(500).json({ error: 'Internal error' });
  }
});

/** Changes the weekly days, hours and how many per slot. */
router.post('/vendor/windows/:id/schedule', requireVendorSeat, requireCapability('SCHEDULE'), async (req, res) => {
  const parsed = scheduleWrite.safeParse(req.body);
  const windowId = String(req.params.id ?? '');
  const { seller, seat } = req.vendor!;
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid schedule', blockers: ['Pick days, hours and how many'] });
    return;
  }
  if (!seatCanSeeBookable(seat.role as SeatRole, seat.bookableIds, windowId)) {
    res.status(404).json({ error: 'No such offering' });
    return;
  }
  try {
    res.status(200).json(await updateSchedule({ sellerId: seller.id, windowId, schedule: parsed.data }));
  } catch (err) {
    if (err instanceof NotFound) {
      res.status(404).json({ error: 'No such offering' });
      return;
    }
    if (err instanceof WindowRefused) {
      res.status(422).json({ error: 'Schedule refused', blockers: err.blockers });
      return;
    }
    captureError(err, { route: 'vendor/windows:schedule' });
    res.status(500).json({ error: 'Internal error' });
  }
});

export default router;
