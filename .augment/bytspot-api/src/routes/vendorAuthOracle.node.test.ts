import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import express from 'express';
import { db } from '../lib/db';
import { redisHandle, type RedisLike } from '../vendor/redisHandle';
import vendorAuthRouter, { vendorAuthMailer } from './vendorAuth';

// A tiny in-memory Redis with TTLs, enough for the OTP store.
function fakeRedis(): RedisLike {
  const store = new Map<string, { value: string; expiresAt: number | null }>();
  const live = (key: string) => { const row = store.get(key); if (row && row.expiresAt !== null && row.expiresAt <= Date.now()) store.delete(key); return store.get(key); };
  return {
    get: async (key) => live(key)?.value ?? null,
    set: async (key, value, _mode, seconds) => { store.set(key, { value, expiresAt: Date.now() + seconds * 1000 }); return 'OK'; },
    del: async (...keys) => keys.filter((key) => store.delete(key)).length,
    ttl: async (key) => { const row = live(key); return !row ? -2 : row.expiresAt === null ? -1 : Math.ceil((row.expiresAt - Date.now()) / 1000); },
    incr: async (key) => { const row = live(key); const next = Number(row?.value ?? 0) + 1; store.set(key, { value: String(next), expiresAt: row?.expiresAt ?? null }); return next; },
    expire: async (key, seconds) => { const row = live(key); if (row) row.expiresAt = Date.now() + seconds * 1000; return 1; },
    getdel: async (key) => { const value = live(key)?.value ?? null; store.delete(key); return value; },
  };
}

test('REA V1: /vendor/auth/code answers a seated and an unknown address the same way', async () => {
  redisHandle.get = (() => { const r = fakeRedis(); return () => r; })();
  const sent: string[] = [];
  vendorAuthMailer.isConfigured = () => true;
  vendorAuthMailer.sendCode = async (to: string) => { sent.push(to); };
  (db.user as any).findUnique = async ({ where }: any) => (where.email === 'owner@lounge.com' ? { id: 'u-owner' } : null);
  (db.vendorSeat as any).count = async () => 1;

  const app = express();
  app.set('trust proxy', true);
  app.use(express.json());
  app.use(vendorAuthRouter);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  let ip = 10;
  const ask = async (email: string) => {
    // A fresh client address each time so only the per-address rules apply.
    const res = await fetch(`${base}/vendor/auth/code`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': `198.51.100.${ip++}` }, body: JSON.stringify({ email }) });
    return { status: res.status, body: await res.json() as Record<string, unknown> };
  };
  try {
    const real = await ask('owner@lounge.com');
    const unknown = await ask('nobody@lounge.com');
    assert.equal(real.status, 200);
    assert.equal(unknown.status, 200);
    assert.deepEqual(Object.keys(real.body), Object.keys(unknown.body));
    assert.match(String(real.body.challengeId), /^chal_[0-9a-f]{32}$/);
    assert.match(String(unknown.body.challengeId), /^chal_[0-9a-f]{32}$/);
    assert.notEqual(unknown.body.challengeId, `chal_${'0'.repeat(32)}`, 'no tell-tale decoy id');
    // Asking again inside the cooldown is refused for both, not just the real one.
    assert.equal((await ask('owner@lounge.com')).status, 429);
    assert.equal((await ask('nobody@lounge.com')).status, 429);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(sent, ['owner@lounge.com'], 'only the seated address gets an email');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
