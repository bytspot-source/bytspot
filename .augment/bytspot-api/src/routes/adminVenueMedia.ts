import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import { db } from '../lib/db';
import { getRedis } from '../lib/redis';
import { captureError } from '../lib/observability';
import { requireAuth } from '../middleware/auth';
import { adminGroupFor, auditAdminAction, type AdminGroup } from '../services/adminRbac';
import { isVenueMediaKind, venueMediaUrl, venueObjectKey, VENUE_GALLERY_CAP } from '../services/venueMedia';
import {
  MEDIA_MAX_VIDEO_BYTES,
  MEDIA_REFUSALS,
  mediaHttpStatus,
  parseVendorMediaDataUri,
  planUpload,
  planVideoUpload,
  type MediaRefusal,
} from '../vendor/media';
import {
  bytesFromRow,
  deleteVendorObject,
  headVendorObject,
  nextMediaId,
  objectStoreConfigured,
  presignVendorGet,
  presignVendorPut,
  readVendorObject,
  writeVendorObject,
} from '../vendor/mediaStore';

/**
 * Bytspot-curated venue media. Only the Bytspot team uploads here, so a file
 * is approved the moment an admin saves it. Guests see it only while the venue
 * is Bytspot-controlled (see services/venueMedia.ts).
 */
const router = Router();

const uploadBody = z.object({
  kind: z.string().trim().min(1).max(16),
  position: z.number().int().min(0).max(32).optional(),
  dataUri: z.string().min(32).max(4_000_000),
});

const videoIntentBody = z.object({
  mimeType: z.string().trim().min(1).max(64),
  byteSize: z.number().int().positive(),
});

type AdminRequest = Request & { adminGroup?: AdminGroup };

function requireAdmin(req: AdminRequest, res: Response, next: NextFunction): void {
  const group = adminGroupFor(req.user?.userId);
  if (!group) {
    res.status(403).json({ error: 'Admin group membership required' });
    return;
  }
  req.adminGroup = group;
  next();
}

function refuse(res: Response, reason: MediaRefusal): void {
  res.status(mediaHttpStatus(reason)).json({ error: 'Could not save', blockers: [MEDIA_REFUSALS[reason]] });
}

function audit(req: AdminRequest, action: string, detail: Record<string, string | number | boolean>): void {
  auditAdminAction({ actorId: req.user!.userId, actorEmail: req.user!.email, group: req.adminGroup!, action, detail });
}

/** venues.list caches for 30 seconds; a change an admin just made should show now. */
async function forgetVenueLists(): Promise<void> {
  const redis = getRedis();
  if (redis) await redis.del('venues:all', 'venues:all:free', 'venues:all:paid').catch(() => undefined);
}

async function listMedia(venueId: string) {
  const rows = await db.venueMedia.findMany({
    where: { venueId },
    orderBy: [{ kind: 'asc' }, { position: 'asc' }],
    select: { id: true, kind: true, position: true, mimeType: true, byteSize: true },
  });
  return {
    media: rows.map((row) => ({ ...row, url: venueMediaUrl(row.id) })),
    videoAvailable: objectStoreConfigured(),
    galleryCap: VENUE_GALLERY_CAP,
  };
}

async function existingFor(venueId: string) {
  return db.venueMedia.findMany({ where: { venueId }, select: { kind: true, position: true } });
}

async function compactGallery(venueId: string): Promise<void> {
  const rows = await db.venueMedia.findMany({
    where: { venueId, kind: 'gallery' },
    orderBy: { position: 'asc' },
    select: { id: true, position: true },
  });
  if (rows.every((row, index) => row.position === index)) return;
  // Unique (venue, kind, position) cannot shuffle in place. Park, then pack.
  await db.$transaction(async (tx) => {
    for (const row of rows) await tx.venueMedia.update({ where: { id: row.id }, data: { position: row.position + 1_000 } });
    for (const [index, row] of rows.entries()) await tx.venueMedia.update({ where: { id: row.id }, data: { position: index } });
  });
}

async function loadVenue(id: string) {
  return db.venue.findUnique({ where: { id }, select: { id: true } });
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && (err as { code?: unknown }).code === 'P2002';
}

router.get('/admin/venues/:id/media', requireAuth, requireAdmin, async (req, res) => {
  try {
    const venue = await loadVenue(String(req.params.id));
    if (!venue) return void res.status(404).json({ error: 'Not found' });
    res.json(await listMedia(venue.id));
  } catch (err) {
    captureError(err, { route: 'admin/venues/:id/media:get' });
    res.status(500).json({ error: 'Internal error' });
  }
});

router.post('/admin/venues/:id/media', requireAuth, requireAdmin, async (req: AdminRequest, res) => {
  try {
    const venue = await loadVenue(String(req.params.id));
    if (!venue) return void res.status(404).json({ error: 'Not found' });
    const parsed = uploadBody.safeParse(req.body);
    if (!parsed.success || !isVenueMediaKind(parsed.data.kind) || parsed.data.kind === 'video') {
      return void res.status(400).json({ error: 'Invalid media', blockers: ['Attach a JPEG, PNG or WebP photo'] });
    }
    const kind = parsed.data.kind;
    const plan = planUpload({
      parent: 'location', kind, position: parsed.data.position,
      existing: await existingFor(venue.id), storeConfigured: objectStoreConfigured(),
    });
    if (!plan.ok) return refuse(res, plan.reason);
    const payload = parseVendorMediaDataUri(kind, parsed.data.dataUri);
    if (!payload.ok) return refuse(res, payload.reason);

    const previous = plan.replace
      ? await db.venueMedia.findFirst({ where: { venueId: venue.id, kind, position: plan.position }, select: { id: true, storageKey: true } })
      : null;
    const mediaId = previous?.id ?? nextMediaId();
    const storageKey = objectStoreConfigured() ? venueObjectKey({ venueId: venue.id, kind, mediaId: nextMediaId() }) : null;
    if (storageKey) await writeVendorObject({ key: storageKey, bytes: payload.bytes, mimeType: payload.mimeType });

    const file = {
      mimeType: payload.mimeType,
      bytes: storageKey ? null : Uint8Array.from(payload.bytes),
      byteSize: payload.bytes.length,
      storageKey,
      uploadedByUserId: req.user!.userId,
    };
    try {
      const row = previous
        ? await db.venueMedia.update({ where: { id: previous.id }, data: file })
        : await db.venueMedia.create({ data: { id: mediaId, venueId: venue.id, kind, position: plan.position, ...file } });
      if (previous?.storageKey) await deleteVendorObject(previous.storageKey);
      audit(req, 'admin.venues.media.upload', { venueId: venue.id, mediaId: row.id, kind });
      await forgetVenueLists();
      res.status(previous ? 200 : 201).json(await listMedia(venue.id));
    } catch (err) {
      if (storageKey) await deleteVendorObject(storageKey);
      if (isUniqueViolation(err)) return refuse(res, 'at-capacity');
      throw err;
    }
  } catch (err) {
    captureError(err, { route: 'admin/venues/:id/media:post' });
    res.status(500).json({ error: 'Internal error' });
  }
});

/** Video never rides JSON: the browser PUTs the clip to a presigned URL, then completes here. */
router.post('/admin/venues/:id/media/uploads', requireAuth, requireAdmin, async (req, res) => {
  try {
    const venue = await loadVenue(String(req.params.id));
    if (!venue) return void res.status(404).json({ error: 'Not found' });
    if (!objectStoreConfigured()) return refuse(res, 'video-unavailable');
    const parsed = videoIntentBody.safeParse(req.body);
    if (!parsed.success) return void res.status(400).json({ error: 'Invalid media', blockers: ['Attach an MP4, WebM, or QuickTime clip'] });
    const size = planVideoUpload(parsed.data);
    if (!size.ok) return refuse(res, size.reason);
    const mediaId = nextMediaId();
    const upload = presignVendorPut({ key: venueObjectKey({ venueId: venue.id, kind: 'video', mediaId }), mimeType: parsed.data.mimeType });
    res.status(201).json({ upload: { mediaId, url: upload.url, method: upload.method, headers: upload.headers, expiresAt: upload.expiresAt } });
  } catch (err) {
    captureError(err, { route: 'admin/venues/:id/media/uploads:post' });
    res.status(500).json({ error: 'Internal error' });
  }
});

router.post('/admin/venues/:id/media/uploads/:mediaId', requireAuth, requireAdmin, async (req: AdminRequest, res) => {
  try {
    const venue = await loadVenue(String(req.params.id));
    if (!venue) return void res.status(404).json({ error: 'Not found' });
    if (!objectStoreConfigured()) return refuse(res, 'video-unavailable');
    const parsed = videoIntentBody.safeParse(req.body);
    if (!parsed.success) return void res.status(400).json({ error: 'Invalid media', blockers: ['Attach an MP4, WebM, or QuickTime clip'] });
    const size = planVideoUpload(parsed.data);
    if (!size.ok) return refuse(res, size.reason);

    const storageKey = venueObjectKey({ venueId: venue.id, kind: 'video', mediaId: String(req.params.mediaId) });
    const object = await headVendorObject(storageKey);
    if (!object) return void res.status(409).json({ error: 'Could not save', blockers: ['That clip never arrived. Try again.'] });
    if (object.byteSize <= 0 || object.byteSize > parsed.data.byteSize || object.byteSize > MEDIA_MAX_VIDEO_BYTES) {
      await deleteVendorObject(storageKey);
      return refuse(res, 'too-large');
    }
    const storedMime = object.mimeType?.split(';')[0]?.trim().toLowerCase();
    if (storedMime && storedMime !== parsed.data.mimeType) {
      await deleteVendorObject(storageKey);
      return refuse(res, 'bad-payload');
    }

    const previous = await db.venueMedia.findFirst({ where: { venueId: venue.id, kind: 'video', position: 0 }, select: { id: true, storageKey: true } });
    const file = { mimeType: parsed.data.mimeType, bytes: null, byteSize: object.byteSize, storageKey, uploadedByUserId: req.user!.userId };
    try {
      const row = previous
        ? await db.venueMedia.update({ where: { id: previous.id }, data: file })
        : await db.venueMedia.create({ data: { id: String(req.params.mediaId), venueId: venue.id, kind: 'video', position: 0, ...file } });
      if (previous?.storageKey && previous.storageKey !== storageKey) await deleteVendorObject(previous.storageKey);
      audit(req, 'admin.venues.media.upload', { venueId: venue.id, mediaId: row.id, kind: 'video' });
      await forgetVenueLists();
      res.status(previous ? 200 : 201).json(await listMedia(venue.id));
    } catch (err) {
      if (storageKey !== previous?.storageKey) await deleteVendorObject(storageKey);
      if (isUniqueViolation(err)) return refuse(res, 'at-capacity');
      throw err;
    }
  } catch (err) {
    captureError(err, { route: 'admin/venues/:id/media/uploads:complete' });
    res.status(500).json({ error: 'Internal error' });
  }
});

router.delete('/admin/venues/:id/media/:mediaId', requireAuth, requireAdmin, async (req: AdminRequest, res) => {
  try {
    const venueId = String(req.params.id);
    const existing = await db.venueMedia.findFirst({
      where: { id: String(req.params.mediaId), venueId },
      select: { id: true, kind: true, storageKey: true },
    });
    if (!existing) return void res.status(404).json({ error: 'Not found' });
    await db.venueMedia.delete({ where: { id: existing.id } });
    await deleteVendorObject(existing.storageKey);
    if (existing.kind === 'gallery') await compactGallery(venueId);
    audit(req, 'admin.venues.media.delete', { venueId, mediaId: existing.id, kind: existing.kind });
    await forgetVenueLists();
    res.json(await listMedia(venueId));
  } catch (err) {
    captureError(err, { route: 'admin/venues/:id/media:delete' });
    res.status(500).json({ error: 'Internal error' });
  }
});

router.get('/media/venue/:mediaId', async (req, res) => {
  try {
    const media = await db.venueMedia.findUnique({
      where: { id: String(req.params.mediaId) },
      select: { mimeType: true, bytes: true, storageKey: true },
    });
    if (!media) return void res.status(404).json({ error: 'Not found' });
    if (media.storageKey && objectStoreConfigured()) {
      res.setHeader('Cache-Control', 'public, max-age=60');
      return res.redirect(302, presignVendorGet({ key: media.storageKey }).url);
    }
    const bytes = bytesFromRow(media.bytes) ?? (await readVendorObject(media.storageKey));
    if (!bytes) return void res.status(404).json({ error: 'Not found' });
    res.setHeader('Content-Type', media.mimeType);
    res.setHeader('Content-Length', String(bytes.length));
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    res.status(200).send(bytes);
  } catch (err) {
    captureError(err, { route: 'media/venue/:mediaId' });
    res.status(404).json({ error: 'Not found' });
  }
});

export default router;
