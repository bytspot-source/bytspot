import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import express from 'express';
import helmet from 'helmet';
import planLandingRouter from './planLanding';
import { db } from '../lib/db';

const plan = db.plan as any;

const proposed = {
  id: 'plan-1',
  title: 'Rooftop then dinner',
  startsAt: new Date(Date.now() + 60 * 60 * 1000),
  endsAt: new Date(Date.now() + 5 * 60 * 60 * 1000),
  areaLabel: 'Midtown',
  lifecycle: 'proposed',
  expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
  creator: { name: 'Ava Reed' },
};

async function get(planId: string, userAgent?: string): Promise<{ status: number; html: string; csp: string | null; cache: string | null; vary: string | null }> {
  const app = express();
  app.use(helmet());
  app.use(planLandingRouter);
  const server = app.listen(0);
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/plan/${planId}`, {
      headers: userAgent ? { 'user-agent': userAgent } : {},
    });
    return {
      status: res.status, html: await res.text(),
      csp: res.headers.get('content-security-policy'), cache: res.headers.get('cache-control'),
      vary: res.headers.get('vary'),
    };
  } finally {
    server.close();
  }
}

beforeEach(() => {
  plan.findUnique = async () => proposed;
});

test('The invite previews as the friend and the plan, and points at the App Store', async () => {
  const { status, html, csp, cache, vary } = await get('plan-1');
  assert.equal(status, 200);
  // A crawler never runs JavaScript, so the invite must be in the response bytes.
  assert.match(html, /Ava invited you to a plan/);
  assert.match(html, /Rooftop then dinner/);
  assert.match(html, /Midtown/);
  assert.match(html, /apps\.apple\.com\/app\/id6761876421/);
  // app-id only — there is no Plan App Clip to offer.
  assert.match(html, /apple-itunes-app" content="app-id=6761876421/);
  assert.doesNotMatch(html, /app-clip-bundle-id/);
  // Honest: an invite, never a confirmation.
  assert.match(html, /you decide if you're in/);
  assert.match(csp ?? '', /default-src 'none'/);
  assert.doesNotMatch(csp ?? '', /script-src/);
  assert.match(cache ?? '', /max-age=60/);
  assert.equal(vary, 'User-Agent');
});

test('Only the first name is shown to a link-holder', async () => {
  const { html } = await get('plan-1');
  assert.match(html, /Ava invited you to a plan/);
  assert.doesNotMatch(html, /Reed/);
});

test('A plan with no time set says so rather than inventing one', async () => {
  plan.findUnique = async () => ({ ...proposed, startsAt: null });
  const { html } = await get('plan-1');
  assert.match(html, /When TBD/);
});

test('A creator-controlled title is escaped, never executed', async () => {
  plan.findUnique = async () => ({ ...proposed, title: '<script>alert(1)</script>' });
  const { html } = await get('plan-1');
  assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/);
  assert.match(html, /&lt;script&gt;/);
});

test('An in-app browser is told how to escape to Safari', async () => {
  const { html } = await get('plan-1', 'Mozilla/5.0 Instagram 300.0');
  assert.match(html, /Open in Safari/);
});

test('A cancelled plan is indistinguishable from one that never existed', async () => {
  plan.findUnique = async () => ({ ...proposed, lifecycle: 'cancelled', cancelledAt: new Date() });
  const { status, html, cache } = await get('plan-1');
  assert.equal(status, 404);
  assert.match(html, /isn't available/);
  assert.doesNotMatch(html, /Rooftop then dinner/);
  assert.equal(cache, 'no-store');
});

test('An expired proposed plan 404s', async () => {
  plan.findUnique = async () => ({ ...proposed, expiresAt: new Date(Date.now() - 1000) });
  assert.equal((await get('plan-1')).status, 404);
});

test('A confirmed plan that already ended 404s', async () => {
  plan.findUnique = async () => ({ ...proposed, lifecycle: 'confirmed', endsAt: new Date(Date.now() - 1000) });
  assert.equal((await get('plan-1')).status, 404);
});

test('A missing plan 404s', async () => {
  plan.findUnique = async () => null;
  assert.equal((await get('plan-1')).status, 404);
});

test('An over-length id 404s without touching the database', async () => {
  let called = false;
  plan.findUnique = async () => { called = true; return proposed; };
  const { status } = await get('x'.repeat(129));
  assert.equal(status, 404);
  assert.equal(called, false);
});

test('A database outage is a 500, not a false "gone"', async () => {
  plan.findUnique = async () => { throw new Error('db down'); };
  const { status, html } = await get('plan-1');
  assert.equal(status, 500);
  assert.match(html, /can't load this right now/);
  assert.doesNotMatch(html, /isn't available/);
});
