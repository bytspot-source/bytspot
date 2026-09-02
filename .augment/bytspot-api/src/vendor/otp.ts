import { createHmac, randomBytes, randomInt, timingSafeEqual } from 'crypto';
import { config } from '../config';
import { requireRedis } from './redisHandle';
import { AUTH } from './contract';

/**
 * Sign-in challenges, in Redis.
 *
 * Redis rather than a table because expiry is the whole lifecycle: a challenge
 * is worthless after ten minutes and a table of email hashes is not, so
 * automatic eviction beats a cleanup job that can silently stop running.
 *
 * Redis is required here, not optional. The cache falls back to null when
 * REDIS_URL is unset, but an auth store that degrades to in-process memory
 * would reset every challenge on deploy and, worse, let each instance disagree
 * about how many attempts a code has had. Sign-in fails closed instead.
 */

const CHALLENGE_PREFIX = 'vendor:otp:';
const SEND_EMAIL_PREFIX = 'vendor:otp:send:email:';
const SEND_IP_PREFIX = 'vendor:otp:send:ip:';
const SUBMIT_IP_PREFIX = 'vendor:otp:submit:ip:';

const SENDS_PER_EMAIL_HOUR = 5;
const SENDS_PER_IP_HOUR = 10;
const SUBMITS_PER_IP_HOUR = 30;
const HOUR_SECS = 3600;

export interface Challenge {
  id: string;
  codeHash: string;
  attempts: number;
}

export type ChallengeVerdict =
  | { ok: true; userId: string }
  | { ok: false; reason: 'unknown' | 'locked' | 'mismatch' };

/**
 * HMAC rather than a bare hash. An email address has almost no entropy, so a
 * plain SHA-256 of one is reversible by guessing common addresses; keyed, it is
 * only reversible by someone who already has the key.
 */
export function hashEmailForChallenge(email: string): string {
  return createHmac('sha256', config.contactHashSalt).update(email.toLowerCase()).digest('hex');
}

/** Hashed with the same keyed construction, so a dump of Redis reveals no codes. */
function hashCode(challengeId: string, code: string): string {
  return createHmac('sha256', config.contactHashSalt).update(`${challengeId}:${code}`).digest('hex');
}

function constantTimeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export function generateCode(): string {
  const max = 10 ** AUTH.code.length;
  return String(randomInt(0, max)).padStart(AUTH.code.length, '0');
}

/**
 * Whether this address may be sent to again, and how long it must wait.
 *
 * Two separate limits: a short cooldown so one person cannot be mailed
 * repeatedly, and an hourly cap so the cooldown cannot simply be waited out
 * sixty times. Counted against the address rather than the challenge, because
 * a fresh challenge per send would defeat a per-challenge limit.
 */
export async function sendCooldownSecs(email: string): Promise<number> {
  const redis = requireRedis();
  const key = `${SEND_EMAIL_PREFIX}${hashEmailForChallenge(email)}`;
  const [cooldown, hourly] = await Promise.all([
    redis.ttl(`${key}:cool`),
    redis.get(`${key}:hour`),
  ]);
  if (cooldown > 0) return cooldown;
  if (Number(hourly ?? 0) >= SENDS_PER_EMAIL_HOUR) {
    const ttl = await redis.ttl(`${key}:hour`);
    return ttl > 0 ? ttl : HOUR_SECS;
  }
  return 0;
}

export async function recordSend(email: string): Promise<void> {
  const redis = requireRedis();
  const key = `${SEND_EMAIL_PREFIX}${hashEmailForChallenge(email)}`;
  await redis.set(`${key}:cool`, '1', 'EX', AUTH.code.resendCooldownSecs);
  const count = await redis.incr(`${key}:hour`);
  if (count === 1) await redis.expire(`${key}:hour`, HOUR_SECS);
}

/**
 * The per-IP send limit, which is what actually blocks enumeration: the uniform
 * 200 on /code hides whether an address exists, but only if a sweep cannot run
 * thousands of addresses through it.
 */
export async function ipSendCooldownSecs(ip: string): Promise<number> {
  return ipLimitCooldown(`${SEND_IP_PREFIX}${ip}`, SENDS_PER_IP_HOUR);
}

export async function recordIpSend(ip: string): Promise<void> {
  await bumpIpLimit(`${SEND_IP_PREFIX}${ip}`);
}

export async function ipSubmitCooldownSecs(ip: string): Promise<number> {
  return ipLimitCooldown(`${SUBMIT_IP_PREFIX}${ip}`, SUBMITS_PER_IP_HOUR);
}

export async function recordIpSubmit(ip: string): Promise<void> {
  await bumpIpLimit(`${SUBMIT_IP_PREFIX}${ip}`);
}

async function ipLimitCooldown(key: string, limit: number): Promise<number> {
  const redis = requireRedis();
  const count = Number((await redis.get(key)) ?? 0);
  if (count < limit) return 0;
  const ttl = await redis.ttl(key);
  return ttl > 0 ? ttl : HOUR_SECS;
}

async function bumpIpLimit(key: string): Promise<void> {
  const redis = requireRedis();
  const count = await redis.incr(key);
  if (count === 1) await redis.expire(key, HOUR_SECS);
}

/**
 * Creates a challenge and returns the id and the code. The code is never
 * stored, and neither is the address: the resolved user id is held instead, so
 * a dump of this store yields no addresses at all and verification needs no
 * second lookup.
 */
export async function createChallenge(email: string, userId: string): Promise<{ id: string; code: string }> {
  const redis = requireRedis();
  const id = `chal_${randomBytes(16).toString('hex')}`;
  const code = generateCode();
  const challenge: Challenge = { id, codeHash: hashCode(id, code), attempts: 0 };
  await redis.set(`${CHALLENGE_PREFIX}${id}`, JSON.stringify(challenge), 'EX', AUTH.code.ttlSecs);
  // Bound at creation so the client cannot substitute another account's id at
  // submit time. The challenge decides who it is for; the caller only proves
  // they hold the code.
  await redis.set(`${CHALLENGE_PREFIX}${id}:user`, userId, 'EX', AUTH.code.ttlSecs);
  return { id, code };
}

/**
 * One attempt. Consumes the challenge on success and on exhaustion, so a code
 * is single-use and a locked challenge cannot be retried by reconnecting.
 */
export async function verifyChallenge(challengeId: string, code: string): Promise<ChallengeVerdict> {
  const redis = requireRedis();
  const key = `${CHALLENGE_PREFIX}${challengeId}`;
  const raw = await redis.get(key);
  // Redis has already evicted an expired challenge, so absent and expired are
  // the same observation. Both are reported as unknown: distinguishing them
  // would tell a caller that a guessed challenge id was once real.
  if (!raw) return { ok: false, reason: 'unknown' };

  const challenge = JSON.parse(raw) as Challenge;
  const attempts = challenge.attempts + 1;

  if (!constantTimeEqual(challenge.codeHash, hashCode(challengeId, code))) {
    if (attempts >= AUTH.code.maxAttempts) {
      await redis.del(key, `${key}:user`);
      return { ok: false, reason: 'locked' };
    }
    // Counted before the comparison result is returned, and the TTL is
    // preserved: a wrong code must not extend the window it was guessed in.
    const ttl = await redis.ttl(key);
    await redis.set(key, JSON.stringify({ ...challenge, attempts }), 'EX', Math.max(1, ttl));
    return { ok: false, reason: 'mismatch' };
  }

  const userId = await redis.get(`${key}:user`);
  await redis.del(key, `${key}:user`);
  if (!userId) return { ok: false, reason: 'unknown' };
  return { ok: true, userId };
}
