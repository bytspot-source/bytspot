import { Router } from 'express';
import { captureError } from '../lib/observability';
import { requireCapability, requireVendorSeat } from '../middleware/vendorAuth';
import { roleScope, type SeatRole } from '../vendor/contract';
import {
  SessionInUse,
  SessionPartyNotFound,
  SessionRefused,
  authorSessionInput,
  authorPartySession,
  listPartySessions,
  withdrawPartySession,
} from '../vendor/partySessions';

/**
 * Stating what a Party sells.
 *
 * SCHEDULE rather than SELL, matching windows: this shapes supply instead of
 * transacting against it, so a business still being approved may arrange its
 * floor before the night. A SUSPENDED business may not — it honours what it
 * already sold without changing what it offers.
 */
const router = Router();

router.get('/vendor/parties/:partyId/sessions', requireVendorSeat, async (req, res) => {
  try {
    res.status(200).json({ sessions: await listPartySessions(req.vendor!.seller.id, String(req.params.partyId ?? '')) });
  } catch (err) {
    if (err instanceof SessionPartyNotFound) {
      res.status(404).json({ error: 'No such party' });
      return;
    }
    captureError(err, { route: 'vendor/party-sessions:get' });
    res.status(500).json({ error: 'Internal error' });
  }
});

router.post('/vendor/parties/:partyId/sessions', requireVendorSeat, requireCapability('SCHEDULE'), async (req, res) => {
  const parsed = authorSessionInput.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid session', blockers: ['Say what it is, when it runs, and what it costs'] });
    return;
  }

  // New supply, so a seat scoped to assigned bookables cannot mint a session
  // it would then be alone in seeing. Same rule windows hold.
  if (roleScope(req.vendor!.seat.role as SeatRole) === 'assigned') {
    res.status(403).json({ error: 'Not permitted', blockers: ['Your role cannot do that'] });
    return;
  }

  try {
    res.status(201).json(await authorPartySession(req.vendor!.seller.id, String(req.params.partyId ?? ''), parsed.data));
  } catch (err) {
    if (err instanceof SessionPartyNotFound) {
      res.status(404).json({ error: 'No such party' });
      return;
    }
    if (err instanceof SessionRefused) {
      res.status(422).json({ error: 'Session refused', issues: err.issues });
      return;
    }
    captureError(err, { route: 'vendor/party-sessions:post' });
    res.status(500).json({ error: 'Internal error' });
  }
});

router.delete('/vendor/sessions/:id', requireVendorSeat, requireCapability('SCHEDULE'), async (req, res) => {
  if (roleScope(req.vendor!.seat.role as SeatRole) === 'assigned') {
    res.status(403).json({ error: 'Not permitted', blockers: ['Your role cannot do that'] });
    return;
  }

  try {
    await withdrawPartySession(req.vendor!.seller.id, String(req.params.id ?? ''));
    res.status(204).end();
  } catch (err) {
    if (err instanceof SessionPartyNotFound) {
      res.status(404).json({ error: 'No such session' });
      return;
    }
    if (err instanceof SessionInUse) {
      res.status(409).json({ error: 'Already held', blockers: err.blockers });
      return;
    }
    captureError(err, { route: 'vendor/party-sessions:delete' });
    res.status(500).json({ error: 'Internal error' });
  }
});

export default router;
