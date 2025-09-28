import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import '../server.js';

const app = globalThis.__bff_app;
const io = globalThis.__bff_io;
const originalFetch = global.fetch;

describe('Valet wrappers', () => {
  beforeEach(() => {
    io.emit = vi.fn();
    global.fetch = vi.fn(async (url, opts) => {
      const u = String(url);
      if (u.endsWith('/valet/intake')) {
        return { ok: true, status: 201, json: async () => ({ id: 't1', status: 'intake', userId: 'u1', vehicle: { make: 'Tesla', model: 'Model 3' } }) };
      }
      if (u.includes('/valet/vehicles/') && u.endsWith('/status')) {
        return { ok: true, status: 200, json: async () => ({ id: 't1', status: 'ready' }) };
      }
      return { ok: true, status: 200, json: async () => ({}) };
    });
  });
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('rejects invalid intake payload', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/valet/intake', headers: { 'content-type': 'application/json' }, payload: { userId: 'u1' } });
    expect(res.statusCode).toBe(400);
  });

  it('rejects intake with invalid service code', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/valet/intake', headers: { 'content-type': 'application/json' }, payload: { userId: 'u1', vehicle: { make: 'Tesla', model: '3' }, services: ['fake'] } });
    expect(res.statusCode).toBe(400);
  });

  it('rejects intake with too many photos', async () => {
    const photos = Array.from({ length: 11 }, (_, i) => `http://x/${i}.jpg`);
    const res = await app.inject({ method: 'POST', url: '/api/valet/intake', headers: { 'content-type': 'application/json' }, payload: { userId: 'u1', vehicle: { make: 'Tesla', model: '3' }, photos } });
    expect(res.statusCode).toBe(400);
  });

  it('forwards intake with exact body and emits valet:task intake', async () => {
    const payload = { userId: 'u1', vehicle: { make: 'Tesla', model: 'Model 3' }, services: ['basic_wash'] };
    const res = await app.inject({ method: 'POST', url: '/api/valet/intake', headers: { 'content-type': 'application/json' }, payload });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body).toMatchObject({ id: 't1', status: 'intake', userId: 'u1', vehicle: { make: 'Tesla', model: 'Model 3' } });
    // upstream contract: POST /valet/intake with JSON body
    const callsFetch = global.fetch.mock.calls.filter((c) => String(c[0]).endsWith('/valet/intake'));
    expect(callsFetch.length).toBe(1);
    const [url, opts] = callsFetch[0];
    expect(String(url)).toMatch(/\/valet\/intake$/);
    expect(opts?.method).toBe('POST');
    expect(opts?.headers?.['Content-Type']).toBe('application/json');
    expect(opts?.body).toBe(JSON.stringify(payload));

    const calls = io.emit.mock.calls.filter((c) => c[0] === 'valet:task');
    expect(calls.length).toBeGreaterThan(0);
    const payloadEmitted = calls[calls.length - 1][1];
    expect(payloadEmitted).toMatchObject({ id: 't1', status: 'intake' });
  });

  it('rejects invalid status value', async () => {
    const res = await app.inject({ method: 'PATCH', url: '/api/valet/vehicles/t1/status', headers: { 'content-type': 'application/json' }, payload: { status: 'bogus' } });
    expect(res.statusCode).toBe(400);
  });

  it('forwards status update and emits valet:task status', async () => {
    const res = await app.inject({ method: 'PATCH', url: '/api/valet/vehicles/t1/status', headers: { 'content-type': 'application/json' }, payload: { status: 'ready' } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ id: 't1', status: 'ready' });
    const callsFetch = global.fetch.mock.calls.filter((c) => String(c[0]).includes('/valet/vehicles/') && String(c[0]).endsWith('/status'));
    expect(callsFetch.length).toBeGreaterThan(0);
    expect(String(callsFetch[0][0])).toContain('/valet/vehicles/t1/status');
    const calls = io.emit.mock.calls.filter((c) => c[0] === 'valet:task');
    expect(calls.length).toBeGreaterThan(0);
    const payloadEmitted = calls[calls.length - 1][1];
    expect(payloadEmitted).toMatchObject({ id: 't1', status: 'ready' });
  });
});
