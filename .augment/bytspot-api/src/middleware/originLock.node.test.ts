import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import express from 'express';
import { ORIGIN_AUTH_HEADER, originLock, trustedClientIp } from './originLock';

const secret = 's'.repeat(40);

async function serve(lockSecret: string) {
  const app = express();
  app.set('trust proxy', 2);
  app.use(originLock(lockSecret));
  app.get('/health', (_req, res) => { res.json({ ok: true }); });
  app.get('/trpc/x', (req, res) => { res.json({ ip: trustedClientIp(req, lockSecret) }); });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { base, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

test('REA X7: with the lock on, direct-to-origin calls are refused; health checks are not', async () => {
  const { base, close } = await serve(secret);
  try {
    const denied = await fetch(`${base}/trpc/x`);
    assert.equal(denied.status, 403);
    assert.deepEqual(await denied.json(), { error: 'Use https://api.bytspot.app.' });
    assert.equal((await fetch(`${base}/trpc/x`, { headers: { [ORIGIN_AUTH_HEADER]: 'wrong' } })).status, 403);
    assert.equal((await fetch(`${base}/health`)).status, 200);
    const ok = await fetch(`${base}/trpc/x`, { headers: { [ORIGIN_AUTH_HEADER]: secret, 'cf-connecting-ip': '203.0.113.9', 'x-forwarded-for': '1.2.3.4' } });
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), { ip: '203.0.113.9' }, 'CF-Connecting-IP is trusted only after the secret proves the hop');
  } finally { await close(); }
});

test('REA X7: with the lock off nothing changes, and CF-Connecting-IP is never trusted', async () => {
  const { base, close } = await serve('');
  try {
    const res = await fetch(`${base}/trpc/x`, { headers: { 'cf-connecting-ip': '203.0.113.9' } });
    assert.equal(res.status, 200);
    assert.notEqual(((await res.json()) as { ip?: string }).ip, '203.0.113.9');
  } finally { await close(); }
});
