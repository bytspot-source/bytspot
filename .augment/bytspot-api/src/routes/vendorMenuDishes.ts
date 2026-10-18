import { Router, type Request, type Response } from 'express';
import type { Prisma } from '@prisma/client';
import { requireVendorSeat, type VendorContext } from '../middleware/vendorAuth';
import { roleCapabilities, type SeatRole } from '../vendor/contract';
import { seatCanSeeLocation } from '../vendor/media';
import {
  listMenuDishes, MenuEvidenceError, menuTransaction, pendingMenuReview,
  submitMenuDishSchema, withdrawMenuDishSchema,
} from '../services/menuEvidence';

const router = Router();
async function authorize(tx: Prisma.TransactionClient, vendor: VendorContext, locationId: string, write: boolean) {
  // Re-read the seat and lifecycle inside the transaction: request middleware
  // establishes identity, not a lasting grant across a suspension/reassignment.
  const seat = await tx.vendorSeat.findFirst({ where: { id: vendor.seat.id, userId: vendor.userId, sellerId: vendor.seller.id, state: 'ACTIVE' } });
  if (!seat || !roleCapabilities(seat.role as SeatRole).includes('PUBLISH')) throw new MenuEvidenceError(403, 'Your role cannot manage menu dishes.');
  const location = await tx.vendorLocation.findFirst({ where: { id: locationId, sellerId: vendor.seller.id }, include: { seller: true } });
  if (!location || !seatCanSeeLocation(seat.role as SeatRole, seat.locationIds, location.id)) throw new MenuEvidenceError(404, 'Not found');
  if (write && (location.state === 'CLOSED'
    || location.seller.state === 'SUSPENDED' || location.seller.state === 'CLOSED')) {
    throw new MenuEvidenceError(403, 'This business or place cannot change menu dishes.');
  }
  return location;
}

/** Exported for focused request tests; production always enters through requireVendorSeat. */
export async function handleMenuDishes(req: Request, res: Response, action: 'list' | 'save' | 'withdraw'): Promise<void> {
  res.setHeader('Cache-Control', 'private, no-store');
  if (!req.vendor) { res.status(401).json({ error: 'Authentication required' }); return; }
  const vendor = req.vendor;
  const locationId = String(req.params.id);
  try {
    const submitted = action === 'save' ? submitMenuDishSchema.safeParse(req.body) : null;
    const withdrawn = action === 'withdraw' ? withdrawMenuDishSchema.safeParse(req.body) : null;
    if (submitted?.success === false || withdrawn?.success === false) throw new MenuEvidenceError(400, 'Use a dish name, up to five aliases, and the current version when updating.');
    const result = await menuTransaction(async (tx) => {
      const location = await authorize(tx, vendor, locationId, action !== 'list');
      if (submitted?.success) {
        const input = submitted.data;
        const media = await tx.vendorMedia.findFirst({ where: { id: input.mediaId, sellerId: vendor.seller.id,
          locationId, bookableId: null, kind: 'menu' }, select: { id: true } });
        if (!media) throw new MenuEvidenceError(404, 'Menu file not found at this place.');
        if (input.dishId) {
          const saved = await tx.vendorMenuDish.updateMany({ where: { id: input.dishId, locationId, updatedAt: new Date(input.expectedUpdatedAt!) },
            data: { mediaId: input.mediaId, dishName: input.dishName, aliases: input.aliases, ...pendingMenuReview } });
          if (saved.count !== 1) throw new MenuEvidenceError(409, 'The dish changed or was removed. Refresh first.');
        } else {
          if (await tx.vendorMenuDish.count({ where: { locationId } }) >= 100) throw new MenuEvidenceError(409, 'A place can have at most 100 menu dishes.');
          await tx.vendorMenuDish.create({ data: { locationId: location.id, mediaId: input.mediaId,
            dishName: input.dishName, aliases: input.aliases, ...pendingMenuReview } });
        }
      } else if (withdrawn?.success) {
        const removed = await tx.vendorMenuDish.deleteMany({ where: { id: String(req.params.dishId), locationId,
          updatedAt: new Date(withdrawn.data.expectedUpdatedAt) } });
        if (removed.count !== 1) throw new MenuEvidenceError(409, 'The dish changed or was removed. Refresh first.');
      }
      return listMenuDishes(tx, locationId);
    });
    res.json(result);
  } catch (error) {
    if (error instanceof MenuEvidenceError) {
      res.status(error.status).json({ error: 'Could not load or save menu dishes', blockers: [error.message] });
    } else {
      // Never send/log raw Prisma errors: they can contain submitted content.
      res.status(500).json({ error: 'Internal error', blockers: ['Menu dishes are temporarily unavailable'] });
    }
  }
}
router.get('/vendor/locations/:id/menu-dishes', requireVendorSeat, (req, res) => { void handleMenuDishes(req, res, 'list'); });
router.post('/vendor/locations/:id/menu-dishes', requireVendorSeat, (req, res) => { void handleMenuDishes(req, res, 'save'); });
router.post('/vendor/locations/:id/menu-dishes/:dishId/withdraw', requireVendorSeat, (req, res) => { void handleMenuDishes(req, res, 'withdraw'); });
export default router;
