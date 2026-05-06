import { AddressInfo, Server } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import app from '../index';
import { config } from '../config';

const nativeFetch = globalThis.fetch.bind(globalThis);

async function postJson(path: string, body: unknown) {
  const server: Server = app.listen(0);
  try {
    const { port } = server.address() as AddressInfo;
    const res = await nativeFetch(`http://127.0.0.1:${port}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: res.status, json: await res.json() };
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  }
}

describe('REST auth routes', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    (config as any).googleClientIds = [];
  });

  it('mounts POST /auth/google', async () => {
    const res = await postJson('/auth/google', { idToken: 'short' });

    expect(res.status).toBe(400);
    expect(res.json).toHaveProperty('error');
  });

  it('returns 401 for invalid Google tokens', async () => {
    (config as any).googleClientIds = ['google-web-client-id'];
    vi.spyOn(globalThis, 'fetch' as any).mockResolvedValueOnce({ ok: false } as any);

    const res = await postJson('/auth/google', { idToken: 'invalid-google-id-token-that-is-long-enough' });

    expect(res.status).toBe(401);
    expect(res.json).toEqual({ error: 'Google session could not be verified.' });
  });
});