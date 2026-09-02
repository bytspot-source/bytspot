import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { redisHandle, type RedisLike } from './redisHandle';
import { AUTH } from './contract';
import { createChallenge, generateCode, recordSend, sendCooldownSecs, verifyChallenge } from './otp';
import { issueRefreshToken, rotateRefreshToken, signOutToken, spendRefreshToken } from './refreshTokens';

/** A Redis with real expiry semantics on a clock the test controls. */
function fakeRedis(): RedisLike & {
  advance: (secs: number) => void;
  size: () => number;
  dump: () => string;
} {
  let now = 0;
  const store = new Map<string, { value: string; expiresAt: number }>();

  const live = (key: string) => {
    const entry = store.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= now) {
      store.delete(key);
      return undefined;
    }
    return entry;
  };

  return {
    advance: (secs) => {
      now += secs;
    },
    size: () => {
      for (const key of [...store.keys()]) live(key);
      return store.size;
    },
    dump: () => {
      for (const key of [...store.keys()]) live(key);
      return JSON.stringify([...store.entries()]);
    },
    get: async (key) => live(key)?.value ?? null,
    set: async (key, value, _mode, seconds) => {
      store.set(key, { value, expiresAt: now + seconds });
      return 'OK';
    },
    del: async (...keys) => {
      let removed = 0;
      for (const key of keys) if (store.delete(key)) removed += 1;
      return removed;
    },
    ttl: async (key) => {
      const entry = live(key);
      return entry ? entry.expiresAt - now : -2;
    },
    incr: async (key) => {
      const entry = live(key);
      const next = String(Number(entry?.value ?? 0) + 1);
      store.set(key, { value: next, expiresAt: entry?.expiresAt ?? Number.MAX_SAFE_INTEGER });
      return Number(next);
    },
    expire: async (key, seconds) => {
      const entry = live(key);
      if (entry) store.set(key, { value: entry.value, expiresAt: now + seconds });
      return 1;
    },
    getdel: async (key) => {
      const entry = live(key);
      store.delete(key);
      return entry?.value ?? null;
    },
  };
}

let redis: ReturnType<typeof fakeRedis>;

beforeEach(() => {
  redis = fakeRedis();
  redisHandle.get = () => redis;
});

test('a generated code is exactly the contracted length, zero-padded', () => {
  for (let i = 0; i < 200; i += 1) {
    const code = generateCode();
    assert.equal(code.length, AUTH.code.length);
    assert.match(code, /^\d+$/);
  }
});

test('the right code verifies once and then is gone', async () => {
  const { id, code } = await createChallenge('owner@midtown.example', 'usr_1');

  const first = await verifyChallenge(id, code);
  assert.deepEqual(first, { ok: true, userId: 'usr_1' });

  // Single-use. Replaying a correct code must not open a second session.
  const replay = await verifyChallenge(id, code);
  assert.equal(replay.ok, false);
});

test('three wrong guesses lock the challenge, and the third does not also say mismatch', async () => {
  const { id, code } = await createChallenge('owner@midtown.example', 'usr_1');
  const wrong = code === '000000' ? '111111' : '000000';

  assert.deepEqual(await verifyChallenge(id, wrong), { ok: false, reason: 'mismatch' });
  assert.deepEqual(await verifyChallenge(id, wrong), { ok: false, reason: 'mismatch' });
  assert.deepEqual(await verifyChallenge(id, wrong), { ok: false, reason: 'locked' });

  // Locked means consumed: the real code no longer works either, so an attacker
  // cannot burn two guesses and hand the challenge back.
  assert.equal((await verifyChallenge(id, code)).ok, false);
});

test('a wrong guess does not extend the window it was guessed in', async () => {
  const { id, code } = await createChallenge('owner@midtown.example', 'usr_1');
  redis.advance(AUTH.code.ttlSecs - 5);

  const wrong = code === '000000' ? '111111' : '000000';
  await verifyChallenge(id, wrong);

  // Five seconds left before the guess; five seconds left after it.
  redis.advance(6);
  assert.deepEqual(await verifyChallenge(id, code), { ok: false, reason: 'unknown' });
});

test('an expired challenge is indistinguishable from one that never existed', async () => {
  const { id, code } = await createChallenge('owner@midtown.example', 'usr_1');
  redis.advance(AUTH.code.ttlSecs + 1);

  assert.deepEqual(await verifyChallenge(id, code), { ok: false, reason: 'unknown' });
  assert.deepEqual(await verifyChallenge('chal_never_existed', code), { ok: false, reason: 'unknown' });
});

test('a challenge leaves nothing behind once it expires', async () => {
  await createChallenge('owner@midtown.example', 'usr_1');
  assert.ok(redis.size() > 0);
  redis.advance(AUTH.code.ttlSecs + 1);
  // A table of email hashes has value to an attacker; an expired challenge has
  // none. Automatic eviction is why there is no cleanup job to forget to run.
  assert.equal(redis.size(), 0);
});

test('the code is never recoverable from the store', async () => {
  const { id, code } = await createChallenge('owner@midtown.example', 'usr_1');
  const dump = redis.dump();

  // Keyed hash, so a dump yields nothing that can be presented as the code.
  assert.ok(!dump.includes(code), 'the plaintext code must not be in the store');
  // And not derivable by re-hashing: the digest is bound to the challenge id,
  // so a rainbow table over six digits does not transfer between challenges.
  const { createHmac } = await import('crypto');
  const { config } = await import('../config');
  const unbound = createHmac('sha256', config.contactHashSalt).update(code).digest('hex');
  assert.ok(!dump.includes(unbound), 'the code digest must be bound to the challenge id');
  // And no address: the store holds the resolved account id, so a dump of it
  // is not a list of which businesses are on Bytspot and who runs them.
  assert.ok(!dump.includes('owner@midtown.example'), 'no plaintext address in the store');
  assert.ok(dump.includes(id), 'the challenge is keyed by its id');
});

test('resend is refused inside the cooldown, and reports how long is left', async () => {
  const email = 'owner@midtown.example';
  assert.equal(await sendCooldownSecs(email), 0);

  await recordSend(email);
  const wait = await sendCooldownSecs(email);
  assert.ok(wait > 0 && wait <= AUTH.code.resendCooldownSecs);

  redis.advance(AUTH.code.resendCooldownSecs + 1);
  assert.equal(await sendCooldownSecs(email), 0);
});

test('the hourly send cap cannot be waited out one cooldown at a time', async () => {
  const email = 'owner@midtown.example';
  for (let i = 0; i < 5; i += 1) {
    assert.equal(await sendCooldownSecs(email), 0, `send ${i + 1} should be allowed`);
    await recordSend(email);
    redis.advance(AUTH.code.resendCooldownSecs + 1);
  }
  // Sixth inside the hour is capped even though every cooldown was honoured.
  assert.ok((await sendCooldownSecs(email)) > 0);
});

test('a refresh token is single-use and rotates', async () => {
  const first = await issueRefreshToken('usr_1');
  const spent = await spendRefreshToken(first);
  assert.deepEqual(spent.ok && { userId: spent.userId }, { userId: 'usr_1' });

  const second = spent.ok ? await rotateRefreshToken(spent.userId, spent.familyId) : '';
  assert.notEqual(second, first);
  assert.equal((await spendRefreshToken(second)).ok, true);
});

test('replaying a spent token is treated as theft and kills the whole family', async () => {
  const first = await issueRefreshToken('usr_1');
  const spent = await spendRefreshToken(first);
  assert.ok(spent.ok);
  if (!spent.ok) return;

  const second = await rotateRefreshToken(spent.userId, spent.familyId);

  // The stolen copy is presented after the legitimate client already rotated.
  assert.deepEqual(await spendRefreshToken(first), { ok: false, reason: 'replayed' });

  // The descendant the real client is holding dies with it. Both parties are
  // signed out, which is the correct outcome: we cannot tell which one is the
  // thief, and letting the thief keep a live session is the worse error.
  assert.deepEqual(await spendRefreshToken(second), { ok: false, reason: 'replayed' });
});

test('an unknown token is not reported as a replay', async () => {
  // A replay verdict revokes a family, so a stranger's guess must not be able
  // to trigger one.
  assert.deepEqual(await spendRefreshToken('never-issued'), { ok: false, reason: 'unknown' });
});

test('sign-out ends the family, so the cookie cannot be un-deleted', async () => {
  const token = await issueRefreshToken('usr_1');
  await signOutToken(token);
  assert.equal((await spendRefreshToken(token)).ok, false);
});

test('the token itself is not stored', async () => {
  const token = await issueRefreshToken('usr_1');
  const keys = redis.size();
  assert.ok(keys > 0);
  // Held as a digest: a dump of Redis yields nothing presentable.
  assert.equal(await redis.get(`vendor:refresh:${token}`), null);
});

test('sign-in refuses to run without Redis rather than falling back to memory', async () => {
  redisHandle.get = () => null;
  await assert.rejects(() => createChallenge('owner@midtown.example', 'usr_1'), /REDIS_URL is required/);
  await assert.rejects(() => issueRefreshToken('usr_1'), /REDIS_URL is required/);
});
