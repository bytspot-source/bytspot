import type { NextFunction, Request, Response } from 'express';
import type { VendorLocation, VendorSeat, VendorSeller } from '@prisma/client';
import { db } from '../lib/db';
import { verifyVendorAccessToken } from '../vendor/accessToken';
import { effectiveCapabilities, sellerCanUseConsole } from '../vendor/contract';

/** The business this request acts on, and what the caller may do to it. */
export interface VendorContext {
  userId: string;
  seller: VendorSeller;
  seat: VendorSeat;
  locations: VendorLocation[];
  capabilities: string[];
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      vendor?: VendorContext;
    }
  }
}

/** Names the business when a person holds seats in more than one. */
export const SELLER_HEADER = 'x-bytspot-seller';

/**
 * Resolves the caller to one seat at one business, and refuses otherwise.
 *
 * The seller is never taken from the body. A vendor id in a payload is a
 * request to act on someone else's business, and the only thing standing
 * between that and a cross-tenant write is this lookup, which is keyed on the
 * user id the token proved.
 */
export async function requireVendorSeat(req: Request, res: Response, next: NextFunction): Promise<void> {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Missing or invalid authorization header' });
    return;
  }

  const claims = verifyVendorAccessToken(header.slice('Bearer '.length).trim());
  if (!claims) {
    res.status(401).json({ error: 'Invalid or expired token' });
    return;
  }

  const requested = req.headers[SELLER_HEADER];
  const sellerId = typeof requested === 'string' ? requested : undefined;

  const seats = await db.vendorSeat.findMany({
    where: {
      userId: claims.userId,
      state: 'ACTIVE',
      ...(sellerId ? { sellerId } : {}),
    },
    include: { seller: { include: { locations: { orderBy: { createdAt: 'asc' } } } } },
    orderBy: { createdAt: 'asc' },
  });

  // An invited seat can sign in — the console shows the invitation — but it
  // cannot yet act, so it is not a seat for the purposes of a write.
  const usable = seats.filter((seat) => seat.seller.state !== 'CLOSED');

  if (usable.length === 0) {
    // Indistinguishable from a business that does not exist. A caller probing
    // ids must not be able to tell a real one from a fabricated one.
    res.status(403).json({ error: 'No seat at this business' });
    return;
  }

  // Without a header this is only unambiguous for a person with one seat.
  // Guessing for the rest would silently write to the wrong business.
  if (!sellerId && usable.length > 1) {
    res.status(400).json({ error: 'Several businesses; name one', blockers: ['Choose a business first'] });
    return;
  }

  const seat = usable[0];
  if (!sellerCanUseConsole(seat.seller.state)) {
    res.status(403).json({ error: 'This business is closed' });
    return;
  }

  req.vendor = {
    userId: claims.userId,
    seller: seat.seller,
    seat,
    locations: seat.seller.locations,
    // Role and business state together, so a suspended business withholds
    // selling from an owner exactly as the catalog says it should.
    capabilities: effectiveCapabilities(seat.role as never, seat.seller.state as never),
  };
  next();
}

/** Refuses a request whose seat lacks the capability the operation needs. */
export function requireCapability(capability: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.vendor?.capabilities.includes(capability)) {
      res.status(403).json({ error: 'Not permitted', blockers: ['Your role cannot do that'] });
      return;
    }
    next();
  };
}
