import jwt from 'jsonwebtoken';
import { config } from '../config';
import { AUTH } from './contract';

/**
 * The vendor access token.
 *
 * Audience-scoped on purpose. The consumer app signs its tokens with the same
 * secret, so without an audience claim a guest's token would authenticate
 * against vendor routes and a vendor's token against guest routes. `aud` is the
 * only thing separating them, which is why it is verified rather than read.
 */
export const VENDOR_AUDIENCE = 'bytspot:vendor';

export interface VendorTokenClaims {
  userId: string;
  email: string;
}

export function signVendorAccessToken(claims: VendorTokenClaims): string {
  return jwt.sign({ userId: claims.userId, email: claims.email }, config.jwtSecret, {
    audience: VENDOR_AUDIENCE,
    expiresIn: AUTH.token.accessTtlSecs,
  });
}

export function verifyVendorAccessToken(token: string): VendorTokenClaims | null {
  try {
    const payload = jwt.verify(token, config.jwtSecret, { audience: VENDOR_AUDIENCE }) as VendorTokenClaims;
    return payload.userId ? payload : null;
  } catch {
    return null;
  }
}
