import type { VendorLocation, VendorSeat, VendorSeller } from '@prisma/client';
import { db } from '../lib/db';
import {
  requirementsForState,
  sellerCanTransition,
  sellerRequirements,
  type SeatRole,
  type SellerState,
} from './contract';

/**
 * The wire shapes the console decodes. Named for what the client calls them
 * rather than what the tables are called, because the console's types are the
 * contract and the schema is an implementation detail behind it.
 */
export interface SellerDto {
  id: string;
  legalName: string;
  state: SellerState;
  businessMode: 'standard' | 'cottage';
  satisfied: string[];
}

export interface SeatDto {
  id: string;
  sellerId: string;
  personId: string;
  role: SeatRole;
  state: 'INVITED' | 'ACTIVE' | 'SUSPENDED' | 'REVOKED';
  locationIds: string[];
  bookableIds: string[];
  invitedAt?: string;
}

export interface MembershipDto {
  seller: SellerDto;
  seat: SeatDto;
}

/** A location good enough to publish from: active, pinned, and addressed. */
function locationIsUsable(location: VendorLocation): boolean {
  if (location.state !== 'ACTIVE') return false;
  if (!Number.isFinite(location.lat) || !Number.isFinite(location.lng)) return false;
  if (Math.abs(location.lat) > 90 || Math.abs(location.lng) > 180) return false;
  // Null Island is what a failed geocode looks like when nobody checked.
  if (location.lat === 0 && location.lng === 0) return false;
  // A visiting provider publishes no address, so only a fixed place needs one.
  if (location.kind !== 'visiting' && !location.address?.trim()) return false;
  return true;
}

/**
 * Which requirements this business has actually met, recomputed from its own
 * records on every read.
 *
 * Never stored. A stored list is a claim that goes stale the moment a place is
 * paused or a processor restricts an account, and a stale tick tells a vendor
 * they are live when they are not.
 */
export function satisfiedRequirements(
  seller: VendorSeller,
  locations: VendorLocation[],
): string[] {
  const met = (id: string): boolean => {
    switch (id) {
      case 'legalName':
        return Boolean(seller.legalName?.trim());
      case 'contactEmail':
        return Boolean(seller.contactEmail?.trim());
      case 'activeLocation':
        return locations.some(locationIsUsable);
      case 'payoutAccount':
        // Only an active account can receive money. `pending` is where a
        // processor parks an account while it decides, so treating it as met
        // would let a business go live and then fail to be paid.
        return seller.payoutStatus === 'active' && Boolean(seller.payoutReference);
      default:
        // An unknown requirement is never quietly satisfied.
        return false;
    }
  };

  return sellerRequirements()
    .filter((requirement) => met(requirement.id))
    .map((requirement) => requirement.id);
}

/** Requirements this seller's state demands but its records cannot prove. */
export function outstandingRequirements(
  seller: VendorSeller,
  locations: VendorLocation[],
): string[] {
  const satisfied = new Set(satisfiedRequirements(seller, locations));
  return requirementsForState(seller.state).filter((id) => !satisfied.has(id));
}

export function toSellerDto(seller: VendorSeller, locations: VendorLocation[]): SellerDto {
  return {
    id: seller.id,
    // The console renders this as a heading, so an unnamed draft gets a
    // placeholder here rather than an empty element there.
    legalName: seller.legalName?.trim() || 'Unnamed business',
    state: seller.state,
    businessMode: seller.businessMode,
    satisfied: satisfiedRequirements(seller, locations),
  };
}

export function toSeatDto(seat: VendorSeat): SeatDto {
  return {
    id: seat.id,
    sellerId: seat.sellerId,
    // The console calls the principal a person, and it checks this against the
    // id the token proved. They have to be the same value.
    personId: seat.userId,
    role: seat.role,
    state: seat.state,
    locationIds: seat.locationIds,
    bookableIds: seat.bookableIds,
    invitedAt: seat.invitedAt?.toISOString(),
  };
}

/**
 * Moves a business as far up its lifecycle as its records now justify.
 *
 * Derived, like everything else here: the state is a consequence of what the
 * vendor has filled in, not a flag someone sets. Filling in the last missing
 * requirement is what makes a business live, so this runs on write, while the
 * vendor is still looking at the screen that told them what was missing.
 *
 * Only ever forward, and only through DRAFT → PENDING → ACTIVE. Falling back
 * because a place was paused is deliberately not done here: a live business
 * that loses a requirement keeps its state and shows the gap as outstanding,
 * because silently un-publishing someone mid-service is worse than telling
 * them. SUSPENDED and CLOSED are decisions we make about a business, never
 * consequences of its own edits, so they are left alone.
 */
export async function advanceSeller(
  seller: VendorSeller,
  locations: VendorLocation[],
): Promise<VendorSeller> {
  if (seller.state !== 'DRAFT' && seller.state !== 'PENDING') return seller;

  const met = new Set(satisfiedRequirements(seller, locations));
  const reaches = (state: SellerState) => requirementsForState(state).every((id) => met.has(id));

  const target: SellerState = reaches('ACTIVE') ? 'ACTIVE' : reaches('PENDING') ? 'PENDING' : 'DRAFT';
  if (target === seller.state) return seller;
  if (!sellerCanTransition(seller.state as SellerState, target)) return seller;

  return db.vendorSeller.update({ where: { id: seller.id }, data: { state: target } });
}
