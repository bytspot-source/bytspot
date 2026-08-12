import { createHash } from 'crypto';
import { config } from '../config';

/**
 * Server-side contact hashing — the shared contract with the iOS
 * `BytspotContactHasher`. Normalization rules MUST stay byte-identical to the
 * client or member identity hashes will stop matching device contact hashes:
 *   email → trim + lowercase, must contain "@" and be longer than 2 chars
 *   phone → digits only, bare 10-digit numbers are assumed NANP → prefix "1",
 *           anything shorter than 7 digits is rejected
 *   hash  → SHA-256 hex of "<salt>:<kind>:<normalized>"
 */

export function normalizeEmail(raw: string | null | undefined): string | null {
  const value = (raw ?? '').trim().toLowerCase();
  return value.length > 2 && value.includes('@') ? value : null;
}

export function normalizePhone(raw: string | null | undefined): string | null {
  const digits = (raw ?? '').replace(/\D/g, '');
  if (digits.length < 7) return null;
  return digits.length === 10 ? `1${digits}` : digits;
}

function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

export function hashEmail(raw: string | null | undefined): string | null {
  const normalized = normalizeEmail(raw);
  return normalized ? sha256Hex(`${config.contactHashSalt}:email:${normalized}`) : null;
}

export function hashPhone(raw: string | null | undefined): string | null {
  const normalized = normalizePhone(raw);
  return normalized ? sha256Hex(`${config.contactHashSalt}:phone:${normalized}`) : null;
}
