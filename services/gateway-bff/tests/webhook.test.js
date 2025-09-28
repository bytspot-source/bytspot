import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import '../server.js';

const app = globalThis.__bff_app;
const io = globalThis.__bff_io;
const originalFetch = global.fetch;

describe('Stripe webhook', () => {
  beforeEach(() => {
    // Mock io.emit
    io.emit = vi.fn();
    // Mock fetch for markTicketPaid
    global.fetch = vi.fn(async (url, opts) => {
      if (String(url).includes('/valet/tickets/')) {
        return { ok: true, status: 200, json: async () => ({ ok: true }) };
      }
      return { ok: true, status: 200, json: async () => ({}) };
    });
  });
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('marks ticket paid and emits valet:task on checkout.session.completed', async () => {
    const event = {
      type: 'checkout.session.completed',
      data: { object: { id: 'cs_test', metadata: { ticketId: 't123', userId: 'u1' } } }
    };

    const res = await app.inject({
      method: 'POST',
      url: '/api/payments/webhook',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify(event)
    });

    expect(res.statusCode).toBe(200);
    expect(io.emit).toHaveBeenCalled();
    // upstream contract: POST /valet/tickets/:id/paid
    const fetchCall = global.fetch.mock.calls.find((c) => String(c[0]).includes('/valet/tickets/t123/paid'));
    expect(fetchCall).toBeTruthy();
    expect(fetchCall[1]).toMatchObject({ method: 'POST' });

    const calls = io.emit.mock.calls.filter((c) => c[0] === 'valet:task');
    expect(calls.length).toBeGreaterThan(0);
    const payload = calls[calls.length - 1][1];
    expect(payload.id).toBe('t123');
    expect(payload.status).toBe('paid');
  });

  it('is idempotent: same event.id processed once', async () => {
    io.emit = vi.fn();
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) }));
    global.fetch = fetchMock;

    const event = {
      id: 'evt_test_1',
      type: 'checkout.session.completed',
      data: { object: { id: 'cs_test', metadata: { ticketId: 't123' } } }
    };

    const res1 = await app.inject({ method: 'POST', url: '/api/payments/webhook', headers: { 'content-type': 'application/json' }, payload: JSON.stringify(event) });
    const res2 = await app.inject({ method: 'POST', url: '/api/payments/webhook', headers: { 'content-type': 'application/json' }, payload: JSON.stringify(event) });

    expect(res1.statusCode).toBe(200);
    expect(res2.statusCode).toBe(200);
    const calls = io.emit.mock.calls.filter((c) => c[0] === 'valet:task');
    expect(calls.length).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not emit for non-completed event types', async () => {
    io.emit = vi.fn();
    const event = { id: 'evt_test_2', type: 'invoice.paid', data: { object: { id: 'cs_other' } } };
    const res = await app.inject({ method: 'POST', url: '/api/payments/webhook', headers: { 'content-type': 'application/json' }, payload: JSON.stringify(event) });
    expect(res.statusCode).toBe(200);
    const calls = io.emit.mock.calls.filter((c) => c[0] === 'valet:task');
    expect(calls.length).toBe(0);
  });

  it('does not emit when metadata.ticketId missing', async () => {
    io.emit = vi.fn();
    const event = { id: 'evt_test_3', type: 'checkout.session.completed', data: { object: { id: 'cs_test' } } };
    const res = await app.inject({ method: 'POST', url: '/api/payments/webhook', headers: { 'content-type': 'application/json' }, payload: JSON.stringify(event) });
    expect(res.statusCode).toBe(200);
    const calls = io.emit.mock.calls.filter((c) => c[0] === 'valet:task');
    expect(calls.length).toBe(0);
  });

});

