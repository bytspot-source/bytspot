import { Router, type Response } from 'express';
import { z } from 'zod';
import type { VendorLocation, VendorSeller } from '@prisma/client';
import { db } from '../lib/db';
import { normalizeEmail } from '../lib/contactHash';
import { captureError } from '../lib/observability';
import { requireCapability, requireVendorSeat } from '../middleware/vendorAuth';
import { config } from '../config';
import {
  LOCATION_DEFAULTS,
  locationCanPublish,
  locationKind,
  locationOperation,
  type LocationKindId,
  type LocationOperationId,
  type LocationState,
} from '../vendor/contract';
import { candidateBlockers, geocode, geocodeIsConfigured } from '../vendor/geocode';
import { onboardingLink, payoutIsConfigured, refreshPayout, storedPayout } from '../vendor/payout';
import { advanceSeller } from '../vendor/sellerState';

const router = Router();

/**
 * Setting up a business. Every write answers with the whole profile rather than
 * the row it touched, because the console's next render depends on derived
 * state — which requirements are met, whether the business may now go live —
 * and a partial response would leave it guessing.
 */

interface ProfileBody {
  legalName?: string;
  contactEmail?: string;
  locations: unknown[];
  payout?: unknown;
}

function locationDto(location: VendorLocation) {
  return {
    id: location.id,
    label: location.label,
    kind: location.kind,
    state: location.state,
    address: location.address ?? undefined,
    lat: location.lat,
    lng: location.lng,
    radiusMiles: location.radiusMiles ?? undefined,
    timezone: location.timezone ?? undefined,
  };
}

async function profileFor(seller: VendorSeller): Promise<ProfileBody> {
  const locations = await db.vendorLocation.findMany({
    // Closed places are not shown. They are kept for the bookings that
    // reference them, not for the vendor to look at.
    where: { sellerId: seller.id, state: { not: 'CLOSED' } },
    orderBy: { createdAt: 'asc' },
  });
  return {
    legalName: seller.legalName ?? undefined,
    contactEmail: seller.contactEmail ?? undefined,
    locations: locations.map(locationDto),
    payout: storedPayout(seller),
  };
}

/** Re-reads the business, moves its lifecycle if it now qualifies, and answers. */
async function respondWithProfile(res: Response, sellerId: string): Promise<void> {
  const seller = await db.vendorSeller.findUnique({
    where: { id: sellerId },
    include: { locations: true },
  });
  if (!seller) {
    res.status(404).json({ error: 'No such business' });
    return;
  }
  // Advanced on write rather than by a job: the vendor is looking at the screen
  // that told them what was missing, and it has to stop saying so.
  const moved = await advanceSeller(seller, seller.locations);
  res.status(200).json(await profileFor(moved));
}

router.get('/vendor/profile', requireVendorSeat, async (req, res) => {
  try {
    await respondWithProfile(res, req.vendor!.seller.id);
  } catch (err) {
    captureError(err, { route: 'vendor/profile:get' });
    res.status(500).json({ error: 'Internal error' });
  }
});

const profileWrite = z
  .object({
    legalName: z.string().trim().min(1).max(200).optional(),
    contactEmail: z.string().trim().max(320).optional(),
  })
  .refine((body) => body.legalName !== undefined || body.contactEmail !== undefined, {
    message: 'Nothing to save',
  });

router.post('/vendor/profile', requireVendorSeat, requireCapability('SELL'), async (req, res) => {
  const parsed = profileWrite.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid profile', blockers: ['Enter a value first'] });
    return;
  }

  try {
    const data: { legalName?: string; contactEmail?: string } = {};
    if (parsed.data.legalName !== undefined) data.legalName = parsed.data.legalName;
    if (parsed.data.contactEmail !== undefined) {
      const email = normalizeEmail(parsed.data.contactEmail);
      if (!email) {
        res.status(400).json({ error: 'Invalid email', blockers: ['That is not an email address'] });
        return;
      }
      data.contactEmail = email;
    }

    await db.vendorSeller.update({ where: { id: req.vendor!.seller.id }, data });
    await respondWithProfile(res, req.vendor!.seller.id);
  } catch (err) {
    captureError(err, { route: 'vendor/profile:post' });
    res.status(500).json({ error: 'Internal error' });
  }
});

const locationWrite = z.object({
  id: z.string().trim().max(64).optional(),
  label: z.string().trim().min(1).max(120),
  kind: z.enum(['fixed', 'zone', 'mobile', 'visiting']),
  address: z.string().trim().max(400).optional(),
  lat: z.coerce.number(),
  lng: z.coerce.number(),
  radiusMiles: z.coerce.number().optional(),
  timezone: z.string().trim().max(64).optional(),
});

/**
 * Everything wrong with a place, as the vendor would read it.
 *
 * The console checks the same things before it lets the button light up. This
 * checks them again because a client-side rule is a courtesy: the request can
 * be made without the client.
 */
function locationBlockers(input: z.infer<typeof locationWrite>): string[] {
  const kind = locationKind(input.kind as LocationKindId);
  if (!kind) return ['That is not a kind of place'];

  const blockers: string[] = [];
  if (kind.requiresAddress && !input.address?.trim()) {
    blockers.push('This kind of place needs an address');
  }
  if (!Number.isFinite(input.lat) || !Number.isFinite(input.lng)) {
    blockers.push('Pick an address so we can place the pin');
  } else if (Math.abs(input.lat) > 90 || Math.abs(input.lng) > 180) {
    blockers.push('That pin is not a real coordinate');
  } else if (input.lat === 0 && input.lng === 0) {
    // A failed geocode that nobody checked looks exactly like this.
    blockers.push('Pick an address so we can place the pin');
  }

  if (kind.requiresRadius) {
    const radius = input.radiusMiles ?? LOCATION_DEFAULTS.radiusMiles;
    if (!Number.isFinite(radius) || radius <= 0) {
      blockers.push('Say how far you travel');
    } else if (radius > LOCATION_DEFAULTS.maxRadiusMiles) {
      blockers.push(`We cap travel at ${LOCATION_DEFAULTS.maxRadiusMiles} miles`);
    }
  }
  return blockers;
}

router.post('/vendor/locations', requireVendorSeat, requireCapability('SELL'), async (req, res) => {
  const parsed = locationWrite.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid place', blockers: ['Fill in the name and address'] });
    return;
  }

  const blockers = locationBlockers(parsed.data);
  if (blockers.length > 0) {
    res.status(422).json({ error: 'Invalid place', blockers });
    return;
  }

  try {
    const sellerId = req.vendor!.seller.id;
    const kind = locationKind(parsed.data.kind as LocationKindId)!;
    const fields = {
      label: parsed.data.label,
      kind: parsed.data.kind,
      address: kind.requiresAddress ? (parsed.data.address ?? null) : null,
      lat: parsed.data.lat,
      lng: parsed.data.lng,
      radiusMiles: kind.requiresRadius ? (parsed.data.radiusMiles ?? LOCATION_DEFAULTS.radiusMiles) : null,
      timezone: parsed.data.timezone ?? null,
    };

    if (parsed.data.id) {
      // Scoped by seller as well as id, so an id belonging to another business
      // updates nothing rather than updating theirs.
      const updated = await db.vendorLocation.updateMany({
        where: { id: parsed.data.id, sellerId },
        data: fields,
      });
      if (updated.count === 0) {
        res.status(404).json({ error: 'No such place' });
        return;
      }
    } else {
      await db.vendorLocation.create({ data: { ...fields, sellerId, state: 'DRAFT' } });
    }

    await respondWithProfile(res, sellerId);
  } catch (err) {
    captureError(err, { route: 'vendor/locations' });
    res.status(500).json({ error: 'Internal error' });
  }
});

const stateWrite = z.object({
  operation: z.enum(['ACTIVATE_LOCATION', 'PAUSE_LOCATION', 'CLOSE_LOCATION']),
});

/**
 * Moves one place through its lifecycle.
 *
 * Takes the operation the vendor pressed, not the state to land in, so the
 * transition table in the catalog is the only thing that decides what is legal.
 */
router.post('/vendor/locations/:id/state', requireVendorSeat, requireCapability('SELL'), async (req, res) => {
  const parsed = stateWrite.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Unknown operation' });
    return;
  }

  try {
    const sellerId = req.vendor!.seller.id;
    const location = await db.vendorLocation.findFirst({ where: { id: String(req.params.id), sellerId } });
    if (!location) {
      res.status(404).json({ error: 'No such place' });
      return;
    }

    const operation = locationOperation(parsed.data.operation as LocationOperationId)!;
    if (!operation.from.includes(location.state as LocationState)) {
      res.status(409).json({
        error: 'Not allowed from here',
        blockers: [`A ${location.state.toLowerCase()} place cannot do that`],
      });
      return;
    }

    // Going live is the one transition with a precondition beyond the table:
    // the place itself has to be publishable.
    if (operation.to === 'ACTIVE') {
      const blockers = locationBlockers({
        label: location.label,
        kind: location.kind as LocationKindId,
        address: location.address ?? undefined,
        lat: location.lat,
        lng: location.lng,
        radiusMiles: location.radiusMiles ?? undefined,
      });
      if (blockers.length > 0) {
        res.status(422).json({ error: 'Not ready', blockers });
        return;
      }
    }

    await db.vendorLocation.update({ where: { id: location.id }, data: { state: operation.to } });
    await respondWithProfile(res, sellerId);
  } catch (err) {
    captureError(err, { route: 'vendor/locations/state' });
    res.status(500).json({ error: 'Internal error' });
  }
});

const geocodeWrite = z.object({
  query: z.string().trim().min(3).max(400),
  kind: z.enum(['fixed', 'zone', 'mobile', 'visiting']),
});

/**
 * POST, not GET with a query string: an address a vendor is still typing would
 * otherwise land in access logs, browser history and Referer headers.
 */
router.post('/vendor/geocode', requireVendorSeat, async (req, res) => {
  const parsed = geocodeWrite.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid lookup', blockers: ['Type more of the address'] });
    return;
  }

  if (!geocodeIsConfigured()) {
    // Loud rather than an empty list, which would read to the vendor as "your
    // address does not exist".
    res.status(503).json({ error: 'Address lookup is unavailable', blockers: ['Address lookup is down'] });
    return;
  }

  try {
    const outcome = await geocode(parsed.data.query);
    if (!outcome.ok) {
      res.status(502).json({ error: 'Address lookup failed', blockers: ['Address lookup is down'] });
      return;
    }

    // Unusable candidates are returned, not filtered, each carrying why. A
    // vendor who typed a real address and got a town centroid needs to be told
    // that is what happened, not shown an empty list.
    const kind = parsed.data.kind as LocationKindId;
    res.status(200).json({
      candidates: outcome.candidates.map((candidate) => ({
        ...candidate,
        blockers: candidateBlockers(kind, candidate),
      })),
    });
  } catch (err) {
    captureError(err, { route: 'vendor/geocode' });
    res.status(500).json({ error: 'Internal error' });
  }
});

router.post('/vendor/payout/onboarding', requireVendorSeat, requireCapability('SELL'), async (req, res) => {
  if (!payoutIsConfigured()) {
    res.status(503).json({ error: 'Payouts are unavailable', blockers: ['Payout setup is down'] });
    return;
  }

  try {
    // The console's own origin, so the vendor returns to the console rather
    // than to whichever host the API happens to answer on.
    const origin = config.corsOrigins.find((entry) => req.headers.origin === entry) ?? config.corsOrigins[0];
    const handoff = await onboardingLink(req.vendor!.seller, origin);
    if (!handoff) {
      res.status(502).json({ error: 'Payout setup failed', blockers: ['Payout setup is down'] });
      return;
    }
    res.status(200).json(handoff);
  } catch (err) {
    captureError(err, { route: 'vendor/payout/onboarding' });
    res.status(502).json({ error: 'Payout setup failed', blockers: ['Payout setup is down'] });
  }
});

/**
 * Reads back what the processor decided.
 *
 * Pulled live because onboarding finishes on the processor's domain: the vendor
 * lands back here and the stored status is a step behind until the webhook
 * arrives.
 */
router.get('/vendor/payout', requireVendorSeat, async (req, res) => {
  try {
    const payout = await refreshPayout(req.vendor!.seller);
    res.status(200).json({ payout });
  } catch (err) {
    captureError(err, { route: 'vendor/payout' });
    res.status(500).json({ error: 'Internal error' });
  }
});

export default router;
export { locationBlockers, locationCanPublish };
