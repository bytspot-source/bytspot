import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import express from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../config';
import { db } from '../lib/db';
import { resetSuspensionFallbackForTests } from '../services/safety';
import { requireAuth } from './auth';

test('REA X8: the REST requireAuth refuses a suspended account like tRPC does', async () => {
  const previous = config.nodeEnv;
  (config as any).nodeEnv = 'production'; // no Redis in production -> database flag answers
  resetSuspensionFallbackForTests();
  (db.user as any).findUnique = async ({ where }: any) => ({ suspendedAt: where.id === 'suspended-user' ? new Date() : null });
  const app = express();
  app.get('/admin/thing', requireAuth, (req, res) => { res.json({ user: (req as any).user.userId }); });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = (userId: string) => fetch(`${base}/admin/thing`, { headers: { authorization: `Bearer ${jwt.sign({ userId, email: 'x@bytspot.com' }, config.jwtSecret)}` } });
  try {
    assert.equal((await call('suspended-user')).status, 401);
    const ok = await call('fine-user');
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), { user: 'fine-user' });
  } finally {
    (config as any).nodeEnv = previous;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
