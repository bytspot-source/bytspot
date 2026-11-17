import { createHmac, timingSafeEqual } from 'crypto';
import { config } from '../config';

/** How long a pitch link an admin sends to a business keeps working. */
export const PITCH_LINK_DAYS = 60;

const b64 = (data: Buffer | string) => Buffer.from(data).toString('base64url');
const signingKey = (source: string) => createHmac('sha256', source).update('bytspot-pitch-link-v1').digest();
const defaultSource = (): string => config.jwtSecret;

/** A signed, expiring link code naming one listed place. It grants nothing but a view of that place's counts. */
export function signPitchCode(venueId: string, now = new Date(), source: string = defaultSource()): { code: string; expiresAt: Date } {
  const expiresAt = new Date(now.getTime() + PITCH_LINK_DAYS * 24 * 60 * 60 * 1000);
  const body = b64(JSON.stringify({ v: venueId, e: Math.floor(expiresAt.getTime() / 1000) }));
  const mac = b64(createHmac('sha256', signingKey(source)).update(body).digest());
  return { code: `${body}.${mac}`, expiresAt };
}

/** The venue id a code names, or null when it is malformed, tampered with or expired. */
export function readPitchCode(code: string, now = new Date(), source: string = defaultSource()): string | null {
  if (typeof code !== 'string' || code.length > 400) return null;
  const [body, mac, extra] = code.split('.');
  if (!body || !mac || extra !== undefined) return null;
  const expected = createHmac('sha256', signingKey(source)).update(body).digest();
  const given = Buffer.from(mac, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const { v, e } = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as { v?: unknown; e?: unknown };
    if (typeof v !== 'string' || typeof e !== 'number' || e * 1000 <= now.getTime()) return null;
    return v;
  } catch {
    return null;
  }
}

export function pitchUrl(code: string): string {
  return `${config.partyShareBaseUrl}/for-business/${code}`;
}
