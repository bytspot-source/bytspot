import { createPublicKey, verify, type KeyObject } from 'crypto';
import { z } from 'zod';
import { MAP_REPORT_KINDS, REPORT_LIFETIME_MS } from './mapReports';

/** A phone's clock can run a little ahead of the server's. */
const CLOCK_SKEW_MS = 2 * 60 * 1000;
/** Keys a member keeps; registering another drops the oldest. */
export const RELAY_KEYS_PER_MEMBER = 5;

/** The report a phone signs: what it saw, where and when, and the key that signs it. */
const relayedPayload = z.object({
  v: z.literal(1),
  keyId: z.string().min(1).max(128),
  clientReportId: z.string().regex(/^[A-Za-z0-9-]{8,64}$/),
  kind: z.enum(MAP_REPORT_KINDS),
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  venueId: z.string().min(1).max(128).nullable().optional(),
  reportedAt: z.string().datetime(),
});

export type RelayedPayload = z.infer<typeof relayedPayload>;

/** A P-256 public key in its uncompressed 65-byte form, base64; null when it isn't one. */
export function relayPublicKey(base64: string): KeyObject | null {
  const raw = Buffer.from(base64, 'base64');
  if (raw.length !== 65 || raw[0] !== 0x04 || raw.toString('base64') !== base64) return null;
  try {
    return createPublicKey({
      key: { kty: 'EC', crv: 'P-256', x: raw.subarray(1, 33).toString('base64url'), y: raw.subarray(33).toString('base64url') },
      format: 'jwk',
    });
  } catch {
    return null;
  }
}

/** ECDSA P-256 with SHA-256 over the payload's UTF-8 bytes; the signature is r‖s (64 bytes), base64. */
export function verifyRelaySignature(publicKey: string, payload: string, signature: string): boolean {
  const key = relayPublicKey(publicKey);
  const sig = Buffer.from(signature, 'base64');
  if (!key || sig.length !== 64) return false;
  try {
    return verify('sha256', Buffer.from(payload, 'utf8'), { key, dsaEncoding: 'ieee-p1363' }, sig);
  } catch {
    return false;
  }
}

/** The signed report, when it is well formed, names the key that signed it and is under thirty minutes old. */
export function readRelayedPayload(payload: string, keyId: string, now: Date): RelayedPayload | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return null;
  }
  const result = relayedPayload.safeParse(parsed);
  if (!result.success || result.data.keyId !== keyId) return null;
  const age = now.getTime() - new Date(result.data.reportedAt).getTime();
  if (age >= REPORT_LIFETIME_MS || age < -CLOCK_SKEW_MS) return null;
  return result.data;
}
