import { createHash, randomBytes } from 'crypto';
import { requireRedis } from './redisHandle';
import { AUTH } from './contract';

/**
 * Refresh tokens, single-use, with family revocation on replay.
 *
 * Stored as a SHA-256 of the token rather than the token: the value is high
 * entropy, so a plain digest is not guessable, and a dump of Redis then yields
 * nothing that can be presented. Only the browser ever holds the token itself.
 */

const TOKEN_PREFIX = 'vendor:refresh:';
const FAMILY_PREFIX = 'vendor:refresh:family:';

export interface RefreshRecord {
  userId: string;
  /** The sign-in this token descends from. Revoked as a unit on replay. */
  familyId: string;
}

export type RefreshVerdict =
  | { ok: true; userId: string; familyId: string }
  | { ok: false; reason: 'unknown' | 'replayed' };

function digest(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Issues a token in a new family. Used once, at sign-in. */
export async function issueRefreshToken(userId: string): Promise<string> {
  return mintInFamily(userId, `fam_${randomBytes(16).toString('hex')}`);
}

/** Issues the replacement for a spent token, keeping it in the same family. */
export async function rotateRefreshToken(userId: string, familyId: string): Promise<string> {
  return mintInFamily(userId, familyId);
}

async function mintInFamily(userId: string, familyId: string): Promise<string> {
  const redis = requireRedis();
  const token = randomBytes(32).toString('base64url');
  const record: RefreshRecord = { userId, familyId };
  await redis.set(`${TOKEN_PREFIX}${digest(token)}`, JSON.stringify(record), 'EX', AUTH.token.refreshTtlSecs);
  return token;
}

/**
 * Spends a token.
 *
 * The delete is the check: only one caller can remove a given key, so two
 * concurrent presentations of the same token cannot both proceed. A token that
 * is absent but whose family is still alive is a replay of one already spent —
 * treated as theft, because a legitimate client never replays. It received the
 * replacement in the same response as the request that spent the original.
 */
export async function spendRefreshToken(token: string): Promise<RefreshVerdict> {
  const redis = requireRedis();
  const key = `${TOKEN_PREFIX}${digest(token)}`;
  const raw = await redis.getdel(key);

  if (!raw) {
    const spent = await redis.get(`${FAMILY_PREFIX}spent:${digest(token)}`);
    if (spent) {
      await revokeFamily(spent);
      return { ok: false, reason: 'replayed' };
    }
    return { ok: false, reason: 'unknown' };
  }

  const record = JSON.parse(raw) as RefreshRecord;
  if (await familyIsRevoked(record.familyId)) return { ok: false, reason: 'replayed' };

  // Remembered for exactly as long as the token could have lived, so a replay
  // inside its own lifetime is recognised as one rather than as a stranger.
  await redis.set(
    `${FAMILY_PREFIX}spent:${digest(token)}`,
    record.familyId,
    'EX',
    AUTH.token.refreshTtlSecs,
  );
  return { ok: true, userId: record.userId, familyId: record.familyId };
}

export async function revokeFamily(familyId: string): Promise<void> {
  const redis = requireRedis();
  await redis.set(`${FAMILY_PREFIX}revoked:${familyId}`, '1', 'EX', AUTH.token.refreshTtlSecs);
}

export async function familyIsRevoked(familyId: string): Promise<boolean> {
  const redis = requireRedis();
  return Boolean(await redis.get(`${FAMILY_PREFIX}revoked:${familyId}`));
}

/** Sign-out. Ends this sign-in without touching the person's other devices. */
export async function signOutToken(token: string): Promise<void> {
  const redis = requireRedis();
  const raw = await redis.getdel(`${TOKEN_PREFIX}${digest(token)}`);
  if (!raw) return;
  const record = JSON.parse(raw) as RefreshRecord;
  await revokeFamily(record.familyId);
}
