import { Router } from 'express';
import { z } from 'zod';
import { db } from '../lib/db';
import { normalizeEmail } from '../lib/contactHash';
import { captureError } from '../lib/observability';
import { sendVendorInviteEmail } from '../lib/email';
import { requireCapability, requireVendorSeat } from '../middleware/vendorAuth';
import { BOOKABLE_TEMPLATES, type SeatRole } from '../vendor/contract';
import {
  INVITE_EXPIRY_HOURS,
  canGrantRole,
  grantableRoles,
  inviteBlockers,
  listTeam,
  seatMoveRefusal,
  seatMoveTarget,
  userForInvite,
  type SeatOperationId,
} from '../vendor/team';
import { consoleOrigin } from './vendorSetup';

const router = Router();

/**
 * The Staff tab. Handing out a seat is an act of the business, so every route
 * here needs SELL, the same capability that already gates places and demand.
 */

const ROLE_LABELS = new Map(
  (BOOKABLE_TEMPLATES.staffRoles as { id: string; label: string }[]).map((role) => [role.id, role.label]),
);

router.get('/vendor/seats', requireVendorSeat, requireCapability('SELL'), async (req, res) => {
  const { seller, seat } = req.vendor!;
  try {
    res.status(200).json({
      seats: await listTeam(seller.id, seat.id),
      canInvite: grantableRoles(seat.role as SeatRole),
    });
  } catch (err) {
    captureError(err, { route: 'vendor/seats:get' });
    res.status(500).json({ error: 'Internal error' });
  }
});

const inviteWrite = z.object({
  email: z.string().trim().min(3).max(320),
  role: z.string().trim().max(40),
  locationIds: z.array(z.string().max(64)).max(50).default([]),
  bookableIds: z.array(z.string().max(64)).max(200).default([]),
});

router.post('/vendor/seats', requireVendorSeat, requireCapability('SELL'), async (req, res) => {
  const parsed = inviteWrite.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid invite', blockers: ['Enter an email and pick a role'] });
    return;
  }
  const email = normalizeEmail(parsed.data.email);
  if (!email) {
    res.status(400).json({ error: 'Invalid email', blockers: ['That is not an email address'] });
    return;
  }

  const { seller, seat, locations } = req.vendor!;
  try {
    const windows = await db.vendorAvailabilityWindow.findMany({ where: { sellerId: seller.id }, select: { id: true } });
    const blockers = inviteBlockers({
      granter: seat.role as SeatRole,
      role: parsed.data.role,
      locationIds: parsed.data.locationIds,
      bookableIds: parsed.data.bookableIds,
      known: { locationIds: locations.map((entry) => entry.id), bookableIds: windows.map((entry) => entry.id) },
    });
    if (blockers.length) {
      res.status(422).json({ error: 'Invite refused', blockers });
      return;
    }

    const userId = await userForInvite(email);
    const existing = await db.vendorSeat.findUnique({ where: { sellerId_userId: { sellerId: seller.id, userId } } });
    const fields = {
      role: parsed.data.role as SeatRole,
      state: 'INVITED' as const,
      locationIds: [...new Set(parsed.data.locationIds)],
      bookableIds: [...new Set(parsed.data.bookableIds)],
      invitedAt: new Date(),
    };
    if (existing && (existing.state === 'ACTIVE' || existing.state === 'SUSPENDED')) {
      res.status(409).json({ error: 'Already on the team', blockers: ['That person is already on your team'] });
      return;
    }
    if (existing?.state === 'INVITED' && !canGrantRole(seat.role as SeatRole, existing.role as SeatRole)) {
      res.status(403).json({ error: 'Not allowed', blockers: ['Your role cannot change that seat'] });
      return;
    }
    // A removed person can be invited again, and resending an invite restarts its clock.
    if (existing) await db.vendorSeat.update({ where: { id: existing.id }, data: fields });
    else await db.vendorSeat.create({ data: { ...fields, sellerId: seller.id, userId } });

    void sendVendorInviteEmail(email, {
      legalName: seller.legalName ?? 'A business',
      roleLabel: ROLE_LABELS.get(parsed.data.role) ?? parsed.data.role,
      consoleUrl: consoleOrigin(req),
      expiresInDays: Math.round(INVITE_EXPIRY_HOURS / 24),
    });

    res.status(201).json({ seats: await listTeam(seller.id, seat.id), canInvite: grantableRoles(seat.role as SeatRole) });
  } catch (err) {
    captureError(err, { route: 'vendor/seats:post' });
    res.status(500).json({ error: 'Internal error' });
  }
});

const moveWrite = z.object({ operation: z.enum(['SUSPEND_SEAT', 'RESTORE_SEAT', 'REVOKE_SEAT']) });

const MOVE_REFUSALS: Record<string, string> = {
  self: 'You cannot change your own seat',
  unrevocable: 'The owner seat cannot be removed',
  forbidden: 'Your role cannot change that seat',
  'illegal-state': 'That seat is not in a state for this',
};

router.post('/vendor/seats/:id/state', requireVendorSeat, requireCapability('SELL'), async (req, res) => {
  const parsed = moveWrite.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Unknown operation' });
    return;
  }
  const { seller, seat } = req.vendor!;
  try {
    // Scoped by seller as well as id, so another business's seat is not found.
    const target = await db.vendorSeat.findFirst({ where: { id: String(req.params.id), sellerId: seller.id } });
    if (!target) {
      res.status(404).json({ error: 'No such seat' });
      return;
    }
    const operation = parsed.data.operation as SeatOperationId;
    const refusal = seatMoveRefusal({ granter: seat, target, operation });
    if (refusal) {
      res.status(refusal === 'illegal-state' ? 409 : 403).json({ error: 'Not allowed', blockers: [MOVE_REFUSALS[refusal]] });
      return;
    }
    await db.vendorSeat.update({ where: { id: target.id }, data: { state: seatMoveTarget(operation) } });
    res.status(200).json({ seats: await listTeam(seller.id, seat.id), canInvite: grantableRoles(seat.role as SeatRole) });
  } catch (err) {
    captureError(err, { route: 'vendor/seats:state' });
    res.status(500).json({ error: 'Internal error' });
  }
});

export default router;
