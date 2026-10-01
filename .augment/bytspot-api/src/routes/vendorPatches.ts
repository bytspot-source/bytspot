import { Router, type NextFunction, type Request, type Response } from 'express';
import { captureError } from '../lib/observability';
import { requireVendorSeat } from '../middleware/vendorAuth';
import { archivePatch, createPatch, listPatches, patchInput, patchKind, PatchRefused, type PatchKind } from '../vendor/patches';

const router = Router();

/**
 * QR / NFC patches need PUBLISH, like the services they open. Partner links
 * are the owner's, matching Partnerships' `requiresPayouts` in the console's
 * navigation: they record what another business sent, which is a deal the
 * owner made.
 */
function canManage(req: Request, kind: PatchKind): boolean {
  const vendor = req.vendor;
  if (!vendor) return false;
  return kind === 'partner' ? vendor.seat.role === 'owner' : vendor.capabilities.includes('PUBLISH');
}

function requireKind(read: (req: Request) => unknown) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!canManage(req, patchKind(read(req)))) {
      res.status(403).json({ error: 'Not permitted', blockers: ['Your role cannot do that'] });
      return;
    }
    next();
  };
}

router.get('/vendor/patches', requireVendorSeat, requireKind((req) => req.query.kind), async (req, res) => {
  try {
    res.status(200).json({ patches: await listPatches(req.vendor!.seller.id, patchKind(req.query.kind)) });
  } catch (err) {
    captureError(err, { route: 'vendor/patches:get' });
    res.status(500).json({ error: 'Internal error' });
  }
});

router.post('/vendor/patches', requireVendorSeat, requireKind((req) => req.body?.kind), async (req, res) => {
  const parsed = patchInput.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid patch', blockers: ['Choose a place and say where it goes'] });
    return;
  }
  const { seller, seat } = req.vendor!;
  try {
    res.status(201).json({ patch: await createPatch(seller.id, seat.id, parsed.data) });
  } catch (err) {
    if (err instanceof PatchRefused) {
      res.status(409).json({ error: 'Patch refused', blockers: err.blockers });
      return;
    }
    captureError(err, { route: 'vendor/patches:create' });
    res.status(500).json({ error: 'Internal error' });
  }
});

router.post('/vendor/patches/:id/archive', requireVendorSeat, requireKind((req) => req.body?.kind), async (req, res) => {
  try {
    const done = await archivePatch(req.vendor!.seller.id, String(req.params.id), patchKind(req.body?.kind));
    if (!done) {
      res.status(404).json({ error: 'No such patch', blockers: ['That patch is not here'] });
      return;
    }
    res.status(200).json({ archived: true });
  } catch (err) {
    captureError(err, { route: 'vendor/patches:archive' });
    res.status(500).json({ error: 'Internal error' });
  }
});

export default router;
