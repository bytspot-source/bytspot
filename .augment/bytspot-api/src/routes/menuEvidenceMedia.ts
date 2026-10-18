import { Router, type Request, type Response } from 'express';
import { db } from '../lib/db';
import { MENU_REVIEW_MS, menuRevisionMatches, menuSourceMime } from '../services/menuEvidence';
import { bytesFromRow, readVendorObject } from '../vendor/mediaStore';

const loadDish = async (dishId: string) => db.vendorMenuDish.findUnique({
  where: { id: dishId },
  include: { media: true, location: { include: { seller: true, menuVenue: true } } },
});
type EvidenceDish = NonNullable<Awaited<ReturnType<typeof loadDish>>>;

/** Every fetch revalidates the review; possession of the URL grants no lasting access. */
export function liveMenuEvidence(row: EvidenceDish | null, revision: string, now: Date): row is EvidenceDish {
  if (!row || !menuRevisionMatches(revision, row.updatedAt) || row.reviewStatus !== 'approved'
    || !row.reviewedByUserId || !row.reviewedAt || !Number.isFinite(now.getTime())) return false;
  const age = now.getTime() - row.reviewedAt.getTime();
  const { media, location } = row;
  return age >= 0 && age < MENU_REVIEW_MS
    && row.sourceUpdatedAt?.getTime() === media.updatedAt.getTime()
    && Boolean(row.reviewedVenueId) && row.reviewedVenueId === location.menuVenueId
    && location.menuVenue !== null && location.menuVenue.id === row.reviewedVenueId && location.menuVenue.discoverable
    && location.id === row.locationId && location.state === 'ACTIVE' && location.seller.state === 'ACTIVE'
    && media.id === row.mediaId && media.sellerId === location.sellerId
    && media.locationId === row.locationId && media.bookableId === null && media.kind === 'menu'
    && media.reviewStatus === 'approved' && menuSourceMime(media.mimeType) && media.byteSize > 0
    && Boolean((media.bytes?.length ?? 0) > 0 || media.storageKey?.trim());
}

// Plain dependency injection keeps tests off Prisma's proxied methods and the network.
export function createMenuEvidenceMediaHandler(deps = { loadDish, readObject: readVendorObject, now: () => new Date() }) {
  return async (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    const missing = () => res.status(404).json({ error: 'Not found' });
    const dishId = String(req.params.dishId), revision = String(req.params.revision);
    if (!/^(0|[1-9]\d*)$/.test(revision) || !Number.isSafeInteger(Number(revision))) return missing();
    try {
      const row = await deps.loadDish(dishId);
      if (!liveMenuEvidence(row, revision, deps.now())) return missing();
      const bytes = bytesFromRow(row.media.bytes) ?? await deps.readObject(row.media.storageKey);
      if (!bytes?.length) return missing();
      // Object storage is awaited outside a DB transaction. Re-read immediately before sending,
      // including visibility, expiry, binding and exact source version, not just the dish status.
      const current = await deps.loadDish(dishId);
      if (!liveMenuEvidence(current, revision, deps.now()) || current.mediaId !== row.mediaId
        || current.media.updatedAt.getTime() !== row.media.updatedAt.getTime()
        || current.media.storageKey !== row.media.storageKey || current.media.mimeType !== row.media.mimeType
        || current.reviewedVenueId !== row.reviewedVenueId || current.reviewedAt?.getTime() !== row.reviewedAt?.getTime()) return missing();
      res.setHeader('Content-Type', current.media.mimeType);
      res.setHeader('Content-Length', String(bytes.length));
      res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
      return res.status(200).send(bytes);
    } catch {
      // Missing objects, deletion races and storage failures all fail closed.
      return missing();
    }
  };
}

const router = Router();
router.get('/media/menu-evidence/:dishId/:revision', createMenuEvidenceMediaHandler());
export default router;
