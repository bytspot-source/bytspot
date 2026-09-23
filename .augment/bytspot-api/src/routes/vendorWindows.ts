import { Router, type Request, type Response } from 'express';
import { captureError } from '../lib/observability';
import { requireCapability, requireVendorSeat } from '../middleware/vendorAuth';
import { roleScope, type SeatRole, type SellerState } from '../vendor/contract';
import { NotFound } from '../vendor/demandFeed';
import { seatCanSeeBookable, seatCanSeeLocation } from '../vendor/media';
import { WindowRefused, createWindow, createWindowInput, listWindows, setWindowPublished } from '../vendor/windows';

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
    res.status(201).json(await createWindow(seller.id, locations, parsed.data));
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

export default router;
