import type { Request } from 'express';
import { Router, type Response } from 'express';
import { z } from 'zod';
import type { VendorAvailabilityWindow, VendorLocation, VendorMedia } from '@prisma/client';
import { db } from '../lib/db';
import { captureError } from '../lib/observability';
import { requireVendorSeat, type VendorContext } from '../middleware/vendorAuth';
import { verifyVendorAccessToken } from '../vendor/accessToken';
import type { SeatRole, SellerState } from '../vendor/contract';
import {
  MEDIA_REFUSALS,
  mediaDto,
  mediaHttpStatus,
  parseVendorMediaDataUri,
  planUpload,
  seatCanSeeBookable,
  seatCanSeeLocation,
  vendorCanEditMedia,
  type MediaKind,
  type MediaParent,
} from '../vendor/media';
import {
  bytesFromRow,
  deleteVendorObject,
  nextMediaId,
  objectStoreConfigured,
  readVendorObject,
  vendorObjectKey,
  writeVendorObject,
} from '../vendor/mediaStore';

const router = Router();

const uploadBody = z.object({
  kind: z.string().trim().min(1).max(16),
  position: z.number().int().min(0).max(32).optional(),
  dataUri: z.string().min(32).max(4_000_000),
});

function notFound(res: Response) {
  return res.status(404).json({ error: 'Not found' });
}

function refuse(res: Response, reason: keyof typeof MEDIA_REFUSALS) {
  res.status(mediaHttpStatus(reason)).json({ error: 'Could not save', blockers: [MEDIA_REFUSALS[reason]] });
}

function canSeeParent(vendor: VendorContext, parent: MediaParent, id: string): boolean {
  const role = vendor.seat.role as SeatRole;
  if (parent === 'location') return seatCanSeeLocation(role, vendor.seat.locationIds, id);
  return seatCanSeeBookable(role, vendor.seat.bookableIds, id);
}

function canWrite(vendor: VendorContext): boolean {
  return vendorCanEditMedia(vendor.seat.role as SeatRole, vendor.seller.state as SellerState);
}

async function loadLocation(sellerId: string, id: string): Promise<VendorLocation | null> {
  return db.vendorLocation.findFirst({ where: { id, sellerId, state: { not: 'CLOSED' } } });
}

async function loadWindow(
  sellerId: string,
  id: string,
): Promise<(VendorAvailabilityWindow & { location: VendorLocation }) | null> {
  return db.vendorAvailabilityWindow.findFirst({
    where: { id, sellerId },
    include: { location: true },
  });
}

function listWhere(parent: MediaParent, id: string) {
  return parent === 'location' ? { locationId: id } : { bookableId: id };
}

async function listMedia(parent: MediaParent, id: string) {
  const rows = await db.vendorMedia.findMany({
    where: listWhere(parent, id),
    orderBy: [{ kind: 'asc' }, { position: 'asc' }],
    select: { id: true, kind: true, position: true, mimeType: true, byteSize: true },
  });
  return { media: rows.map(mediaDto) };
}

async function compactKind(parent: MediaParent, parentId: string, kind: MediaKind): Promise<void> {
  const rows = await db.vendorMedia.findMany({
    where: { ...listWhere(parent, parentId), kind },
    orderBy: { position: 'asc' },
    select: { id: true, position: true },
  });
  if (rows.every((row, index) => row.position === index)) return;

  // Unique (parent, kind, position) cannot shuffle in place. Park, then pack.
  await db.$transaction(async (tx) => {
    for (const row of rows) {
      await tx.vendorMedia.update({ where: { id: row.id }, data: { position: row.position + 1_000 } });
    }
    for (const [index, row] of rows.entries()) {
      await tx.vendorMedia.update({ where: { id: row.id }, data: { position: index } });
    }
  });
}

async function saveUpload(
  req: Request,
  res: Response,
  vendor: VendorContext,
  parent: MediaParent,
  parentId: string,
): Promise<void> {
  if (!canWrite(vendor)) {
    refuse(res, 'forbidden');
    return;
  }
  if (!canSeeParent(vendor, parent, parentId)) {
    notFound(res);
    return;
  }

  const parsed = uploadBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid media', blockers: ['Attach a photo or menu file'] });
    return;
  }

  const existing = await db.vendorMedia.findMany({
    where: listWhere(parent, parentId),
    select: { kind: true, position: true },
  });
  const plan = planUpload({
    parent,
    kind: parsed.data.kind,
    position: parsed.data.position,
    existing,
  });
  if (!plan.ok) {
    refuse(res, plan.reason);
    return;
  }

  const payload = parseVendorMediaDataUri(plan.kind, parsed.data.dataUri);
  if (!payload.ok) {
    refuse(res, payload.reason);
    return;
  }

  const slotWhere =
    parent === 'location'
      ? { locationId_kind_position: { locationId: parentId, kind: plan.kind, position: plan.position } }
      : { bookableId_kind_position: { bookableId: parentId, kind: plan.kind, position: plan.position } };
  const previous = plan.replace
    ? await db.vendorMedia.findUnique({
        where: slotWhere,
        select: { id: true, storageKey: true },
      })
    : null;

  const mediaId = previous?.id ?? nextMediaId();
  const offload = objectStoreConfigured();
  const storageKey = offload
    ? vendorObjectKey({
        sellerId: vendor.seller.id,
        parent,
        parentId,
        kind: plan.kind,
        mediaId,
      })
    : null;

  if (storageKey) {
    await writeVendorObject({ key: storageKey, bytes: payload.bytes, mimeType: payload.mimeType });
  }

  const data = {
    id: mediaId,
    sellerId: vendor.seller.id,
    locationId: parent === 'location' ? parentId : null,
    bookableId: parent === 'bookable' ? parentId : null,
    kind: plan.kind,
    position: plan.position,
    mimeType: payload.mimeType,
    bytes: storageKey ? null : Uint8Array.from(payload.bytes),
    byteSize: payload.bytes.length,
    storageKey,
  };

  try {
    const row = plan.replace
      ? await db.vendorMedia.upsert({
          where: slotWhere,
          create: data,
          update: {
            mimeType: data.mimeType,
            bytes: data.bytes,
            byteSize: data.byteSize,
            storageKey: data.storageKey,
          },
        })
      : await db.vendorMedia.create({ data });

    if (previous?.storageKey && previous.storageKey !== storageKey) {
      await deleteVendorObject(previous.storageKey);
    }

    res.status(plan.replace ? 200 : 201).json({ media: mediaDto(row) });
  } catch (err) {
    if (storageKey && storageKey !== previous?.storageKey) await deleteVendorObject(storageKey);
    if (typeof err === 'object' && err !== null && 'code' in err && (err as { code?: unknown }).code === 'P2002') {
      refuse(res, 'at-capacity');
      return;
    }
    throw err;
  }
}

router.get('/vendor/locations/:id/media', requireVendorSeat, async (req, res) => {
  try {
    const location = await loadLocation(req.vendor!.seller.id, String(req.params.id));
    if (!location || !canSeeParent(req.vendor!, 'location', location.id)) {
      notFound(res);
      return;
    }
    res.json(await listMedia('location', location.id));
  } catch (err) {
    captureError(err, { route: 'vendor/locations/:id/media:get' });
    res.status(500).json({ error: 'Internal error' });
  }
});

router.post('/vendor/locations/:id/media', requireVendorSeat, async (req, res) => {
  try {
    const location = await loadLocation(req.vendor!.seller.id, String(req.params.id));
    if (!location) {
      notFound(res);
      return;
    }
    await saveUpload(req, res, req.vendor!, 'location', location.id);
  } catch (err) {
    captureError(err, { route: 'vendor/locations/:id/media:post' });
    res.status(500).json({ error: 'Internal error' });
  }
});

router.delete('/vendor/locations/:id/media/:mediaId', requireVendorSeat, async (req, res) => {
  try {
    if (!canWrite(req.vendor!)) {
      refuse(res, 'forbidden');
      return;
    }
    const location = await loadLocation(req.vendor!.seller.id, String(req.params.id));
    if (!location || !canSeeParent(req.vendor!, 'location', location.id)) {
      notFound(res);
      return;
    }
    const existing = await db.vendorMedia.findFirst({
      where: { id: String(req.params.mediaId), sellerId: req.vendor!.seller.id, locationId: location.id },
      select: { id: true, kind: true, storageKey: true },
    });
    if (!existing) {
      notFound(res);
      return;
    }
    await db.vendorMedia.delete({ where: { id: existing.id } });
    await deleteVendorObject(existing.storageKey);
    if (existing.kind === 'gallery' || existing.kind === 'menu') {
      await compactKind('location', location.id, existing.kind);
    }
    res.json(await listMedia('location', location.id));
  } catch (err) {
    captureError(err, { route: 'vendor/locations/:id/media:delete' });
    res.status(500).json({ error: 'Internal error' });
  }
});

router.get('/vendor/bookables/:id/media', requireVendorSeat, async (req, res) => {
  try {
    const window = await loadWindow(req.vendor!.seller.id, String(req.params.id));
    if (!window || !canSeeParent(req.vendor!, 'bookable', window.id)) {
      notFound(res);
      return;
    }
    res.json(await listMedia('bookable', window.id));
  } catch (err) {
    captureError(err, { route: 'vendor/bookables/:id/media:get' });
    res.status(500).json({ error: 'Internal error' });
  }
});

router.post('/vendor/bookables/:id/media', requireVendorSeat, async (req, res) => {
  try {
    const window = await loadWindow(req.vendor!.seller.id, String(req.params.id));
    if (!window) {
      notFound(res);
      return;
    }
    await saveUpload(req, res, req.vendor!, 'bookable', window.id);
  } catch (err) {
    captureError(err, { route: 'vendor/bookables/:id/media:post' });
    res.status(500).json({ error: 'Internal error' });
  }
});

router.delete('/vendor/bookables/:id/media/:mediaId', requireVendorSeat, async (req, res) => {
  try {
    if (!canWrite(req.vendor!)) {
      refuse(res, 'forbidden');
      return;
    }
    const window = await loadWindow(req.vendor!.seller.id, String(req.params.id));
    if (!window || !canSeeParent(req.vendor!, 'bookable', window.id)) {
      notFound(res);
      return;
    }
    const existing = await db.vendorMedia.findFirst({
      where: { id: String(req.params.mediaId), sellerId: req.vendor!.seller.id, bookableId: window.id },
      select: { id: true, kind: true, storageKey: true },
    });
    if (!existing) {
      notFound(res);
      return;
    }
    await db.vendorMedia.delete({ where: { id: existing.id } });
    await deleteVendorObject(existing.storageKey);
    if (existing.kind === 'gallery') {
      await compactKind('bookable', window.id, existing.kind);
    }
    res.json(await listMedia('bookable', window.id));
  } catch (err) {
    captureError(err, { route: 'vendor/bookables/:id/media:delete' });
    res.status(500).json({ error: 'Internal error' });
  }
});

function sendMedia(res: Response, media: { mimeType: string; bytes: Buffer }, cacheControl: string, crossOrigin: boolean) {
  res.setHeader('Content-Type', media.mimeType);
  res.setHeader('Content-Length', String(media.bytes.length));
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', cacheControl);
  if (crossOrigin) res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  return res.status(200).send(media.bytes);
}

async function bytesFor(media: { bytes: Uint8Array | null; storageKey: string | null }): Promise<Buffer | null> {
  const inline = bytesFromRow(media.bytes);
  if (inline) return inline;
  return readVendorObject(media.storageKey);
}

function requestVendorUserId(authorization: string | undefined): string | null {
  if (!authorization?.startsWith('Bearer ')) return null;
  const claims = verifyVendorAccessToken(authorization.slice('Bearer '.length).trim());
  return claims?.userId ?? null;
}

function parentIsPublic(
  media: VendorMedia & {
    location: VendorLocation | null;
    bookable: (VendorAvailabilityWindow & { location: VendorLocation }) | null;
  },
): boolean {
  if (media.location) return media.location.state === 'ACTIVE';
  if (media.bookable) return media.bookable.active && media.bookable.location.state === 'ACTIVE';
  return false;
}

router.get('/media/vendor/:mediaId', async (req, res) => {
  try {
    const media = await db.vendorMedia.findUnique({
      where: { id: String(req.params.mediaId) },
      include: { location: true, bookable: { include: { location: true } } },
    });
    if (!media) return notFound(res);

    const bytes = await bytesFor(media);
    if (!bytes) return notFound(res);

    const published = parentIsPublic(media);
    if (published) return sendMedia(res, { mimeType: media.mimeType, bytes }, 'public, max-age=86400', true);

    const userId = requestVendorUserId(req.headers.authorization);
    if (!userId) return notFound(res);

    const seat = await db.vendorSeat.findFirst({
      where: { sellerId: media.sellerId, userId, state: 'ACTIVE' },
      select: { id: true },
    });
    if (!seat) return notFound(res);
    return sendMedia(res, { mimeType: media.mimeType, bytes }, 'private, no-store', false);
  } catch (err) {
    captureError(err, { route: 'media/vendor/:mediaId' });
    return notFound(res);
  }
});

export default router;
