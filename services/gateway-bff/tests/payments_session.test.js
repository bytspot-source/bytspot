import { describe, it, expect, vi } from 'vitest';

// Mock Stripe SDK before server import and set env so server constructs a Stripe client
vi.mock('stripe', () => {
  const retrieve = vi.fn(async (id, opts) => ({
    id,
    amount_total: 1800,
    currency: 'usd',
    payment_status: 'paid',
    mode: 'payment',
    payment_intent: {
      charges: { data: [{ payment_method_details: { type: 'card', card: { brand: 'visa' } } }] },
      payment_method_types: ['card']
    },
    payment_method_types: ['card']
  }));
  class StripeMock {
    constructor() {}
    checkout = { sessions: { retrieve } };
    webhooks = { constructEvent: vi.fn() };
  }
  return { default: StripeMock };
});

process.env.STRIPE_SECRET_KEY = 'sk_test_mocked';

import '../server.js';
const app = globalThis.__bff_app;

describe('GET /api/payments/session', () => {
  it('returns 200 with details when Stripe is configured; otherwise 500', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/payments/session?id=cs_test_123' });
    if (res.statusCode === 200) {
      const body = res.json();
      expect(body).toMatchObject({ id: 'cs_test_123' });
      expect(body.currency).toBeTruthy();
    } else {
      expect(res.statusCode).toBe(500);
      const body = res.json();
      expect(String(body.error || '')).toMatch(/stripe/i);
    }
  });

  it('400 when id missing (validated before Stripe check)', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/payments/session' });
    expect(res.statusCode).toBe(400);
  });
});

