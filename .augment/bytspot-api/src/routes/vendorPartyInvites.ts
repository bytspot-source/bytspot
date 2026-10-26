import { Router, type Request, type Response } from 'express';
import { captureError } from '../lib/observability';
import { requireCapability, requireVendorSeat } from '../middleware/vendorAuth';
import { roleScope, type SeatRole } from '../vendor/contract';
import { InviteRefused, listSellerInvites, respondToInvite } from '../vendor/partySellerInvites';

/**
 * A host asking this business to sell on their Party.
 *
 * Answering takes SCHEDULE and a seat over the whole business, the same as
 * authoring the sessions accepting makes possible.
 */
const router = Router();

const STATUS: Record<InviteRefused['reason'], number> = { NOT_FOUND: 404, CONFLICT: 409, BAD_REQUEST: 400 };

router.get('/vendor/party-invites', requireVendorSeat, async (req, res) => {
  try {
    res.status(200).json(await listSellerInvites(req.vendor!.seller.id));
  } catch (err) {
    captureError(err, { route: 'vendor/party-invites:get' });
    res.status(500).json({ error: 'Internal error' });
  }
});

function answer(kind: 'accept' | 'decline') {
  return async (req: Request, res: Response) => {
    if (roleScope(req.vendor!.seat.role as SeatRole) === 'assigned') {
      res.status(403).json({ error: 'Not permitted', blockers: ['Your role cannot do that'] });
      return;
    }
    try {
      res.status(200).json(await respondToInvite(req.vendor!.seller.id, req.vendor!.userId, String(req.params.id ?? ''), kind));
    } catch (err) {
      if (err instanceof InviteRefused) {
        res.status(STATUS[err.reason]).json({ error: err.message, blockers: [err.message] });
        return;
      }
      captureError(err, { route: `vendor/party-invites:${kind}` });
      res.status(500).json({ error: 'Internal error' });
    }
  };
}

router.post('/vendor/party-invites/:id/accept', requireVendorSeat, requireCapability('SCHEDULE'), answer('accept'));
router.post('/vendor/party-invites/:id/decline', requireVendorSeat, requireCapability('SCHEDULE'), answer('decline'));

export default router;
