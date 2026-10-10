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

/**
 * Which sign-in a token belongs to. The vendor console and the member app share
 * this store but never each other's tokens: a member's app token must not open
 * the console, and signing out of one must not end the other.
 */
export type RefreshScope = 'vendor' | 'member';

/** Members stay signed in on their phone far longer than a console session. */
const MEMBER_REFRESH_TTL_SECS = 90 * 24 * 60 * 60;

const tokenPrefix = (scope: RefreshScope) => `${scope}:refresh:`;
const familyPrefix = (scope: RefreshScope) => `${scope}:refresh:family:`;
const cutoffPrefix = (scope: RefreshScope) => `${scope}:refresh:cutoff:`;

export function refreshTtlSecs(scope: RefreshScope = 'vendor'): number {
  return scope === 'member' ? MEMBER_REFRESH_TTL_SECS : AUTH.token.refreshTtlSecs;
}

export interface RefreshRecord {
  userId: string;
  /** The sign-in this token descends from. Revoked as a unit on replay. */
  familyId: string;
  /** Epoch ms. Absent on tokens minted before sign-out-everywhere existed. */
  issuedAt?: number;
}

export type RefreshVerdict =
  | { ok: true; userId: string; familyId: string }
  | { ok: false; reason: 'unknown' | 'replayed' | 'revoked' };

function digest(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Issues a token in a new family. Used once, at sign-in. */
export async function issueRefreshToken(userId: string, scope: RefreshScope = 'vendor'): Promise<string> {
  return mintInFamily(userId, `fam_${randomBytes(16).toString('hex')}`, scope);
}

/** Issues the replacement for a spent token, keeping it in the same family. */
export async function rotateRefreshToken(userId: string, familyId: string, scope: RefreshScope = 'vendor'): Promise<string> {
  return mintInFamily(userId, familyId, scope);
}

async function mintInFamily(userId: string, familyId: string, scope: RefreshScope): Promise<string> {
  const redis = requireRedis();
  const token = randomBytes(32).toString('base64url');
  const record: RefreshRecord = { userId, familyId, issuedAt: Date.now() };
  await redis.set(`${tokenPrefix(scope)}${digest(token)}`, JSON.stringify(record), 'EX', refreshTtlSecs(scope));
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
export async function spendRefreshToken(token: string, scope: RefreshScope = 'vendor'): Promise<RefreshVerdict> {
  const redis = requireRedis();
  const key = `${tokenPrefix(scope)}${digest(token)}`;
  const raw = await redis.getdel(key);

  if (!raw) {
    const spent = await redis.get(`${familyPrefix(scope)}spent:${digest(token)}`);
    if (spent) {
      await revokeFamily(spent, scope);
      return { ok: false, reason: 'replayed' };
    }
    return { ok: false, reason: 'unknown' };
  }

  const record = JSON.parse(raw) as RefreshRecord;
  if (await familyIsRevoked(record.familyId, scope)) return { ok: false, reason: 'replayed' };
  const cutoff = Number(await redis.get(`${cutoffPrefix(scope)}${record.userId}`)) || 0;
  if ((record.issuedAt ?? 0) < cutoff) return { ok: false, reason: 'revoked' };

  // Remembered for exactly as long as the token could have lived, so a replay
  // inside its own lifetime is recognised as one rather than as a stranger.
  await redis.set(
    `${familyPrefix(scope)}spent:${digest(token)}`,
    record.familyId,
    'EX',
    refreshTtlSecs(scope),
  );
  return { ok: true, userId: record.userId, familyId: record.familyId };
}

export async function revokeFamily(familyId: string, scope: RefreshScope = 'vendor'): Promise<void> {
  const redis = requireRedis();
  await redis.set(`${familyPrefix(scope)}revoked:${familyId}`, '1', 'EX', refreshTtlSecs(scope));
}

export async function familyIsRevoked(familyId: string, scope: RefreshScope = 'vendor'): Promise<boolean> {
  const redis = requireRedis();
  return Boolean(await redis.get(`${familyPrefix(scope)}revoked:${familyId}`));
}

/** Sign-out. Ends this sign-in without touching the person's other devices. */
export async function signOutToken(token: string, scope: RefreshScope = 'vendor'): Promise<void> {
  const redis = requireRedis();
  const raw = await redis.getdel(`${tokenPrefix(scope)}${digest(token)}`);
  if (!raw) return;
  const record = JSON.parse(raw) as RefreshRecord;
  await revokeFamily(record.familyId, scope);
}

/**
 * Ends every sign-in this person has, on every device. Tokens are not indexed
 * by person, so this records a cutoff instead: anything minted before it is
 * refused when spent. Kept for as long as such a token could still live.
 */
export async function signOutEverywhere(userId: string, now: number = Date.now(), scope: RefreshScope = 'vendor'): Promise<void> {
  const redis = requireRedis();
  await redis.set(`${cutoffPrefix(scope)}${userId}`, String(now), 'EX', refreshTtlSecs(scope));
}
