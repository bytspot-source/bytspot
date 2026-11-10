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
  deletedAt: null,
  expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
  creator: { name: 'Ava Reed' },
};

async function get(planId: string, userAgent?: string, token?: string): Promise<{ status: number; html: string; csp: string | null; cache: string | null; vary: string | null }> {
  const app = express();
  app.use(helmet());
  app.use(planLandingRouter);
  const server = app.listen(0);
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  try {
    const query = token === undefined ? '' : `?t=${encodeURIComponent(token)}`;
    const res = await fetch(`http://127.0.0.1:${port}/plan/${planId}${query}`, {
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
  assert.equal(cache, 'private, no-store');
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

test('A token-bearing invite carries the token into the app hand-off and is never cached', async () => {
  const { status, html, cache } = await get('plan-1', undefined, 'sekret-join-token');
  assert.equal(status, 200);
  // The bearer token rides into the Smart App Banner's app-argument and the
  // share URL so an installed "Open" or a re-tap after install seats the holder.
  assert.match(html, /apple-itunes-app" content="app-id=6761876421, app-argument=[^"]*\?t=sekret-join-token/);
  assert.match(html, /og:url" content="[^"]*\?t=sekret-join-token/);
  // A page that carries a credential must not be cached on a shared CDN.
  assert.equal(cache, 'private, no-store');
  // Fresh installers are told to reopen the invite to take their seat.
  assert.match(html, /reopen this invite to take your seat/);
});

test('A token-less preview cannot be cached past deletion and never claims a seat', async () => {
  const { html, cache } = await get('plan-1');
  assert.doesNotMatch(html, /\?t=/);
  assert.doesNotMatch(html, /reopen this invite/);
  assert.equal(cache, 'private, no-store');
});

test('An over-length token is ignored and the page is treated as a token-less preview', async () => {
  const { html, cache } = await get('plan-1', undefined, 'x'.repeat(201));
  assert.doesNotMatch(html, /\?t=/);
  assert.equal(cache, 'private, no-store');
});

test('An in-app browser is told how to escape to Safari', async () => {
  const { html } = await get('plan-1', 'Mozilla/5.0 Instagram 300.0');
  assert.match(html, /Open in Safari/);
});

test('A cancelled plan is indistinguishable from one that never existed', async () => {
  plan.findUnique = async () => ({ ...proposed, lifecycle: 'cancelled', cancelledAt: new Date() });
  const { status, html, cache } = await get('plan-1');
  assert.equal(status, 404);
  assert.match(html, /isn&#39;t available/);
  assert.doesNotMatch(html, /Rooftop then dinner/);
  assert.equal(cache, 'no-store');
});

test('A tombstone invalidates both the preview and invite, without leaking Plan detail', async () => {
  let selected: any;
  plan.findUnique = async ({ select }: any) => { selected = select; return { ...proposed, deletedAt: new Date() }; };
  for (const linkValue of [undefined, 'fixture-link']) {
    const { status, html, cache } = await get('plan-1', undefined, linkValue);
    assert.equal(status, 404);
    assert.equal(cache, 'no-store');
    assert.doesNotMatch(html, /Rooftop then dinner|Ava|fixture-link/);
  }
  assert.equal(selected.deletedAt, true);
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
  assert.match(html, /can&#39;t load this right now/);
  assert.doesNotMatch(html, /isn&#39;t available/);
});

test('The page offers Open in Bytspot and an App Store fallback, and does not invent stops or a surname', async () => {
  const { html } = await get('plan-1');
  assert.match(html, /<a class="cta cta-primary" href="https:\/\/bytspot\.app\/plan\/plan-1">Open in Bytspot<\/a>/);
  assert.match(html, /Get Bytspot on the App Store/);
  assert.doesNotMatch(html, /Reed/);
  // Itinerary stops, coordinates, and who is going stay off the unauthenticated page.
  assert.doesNotMatch(html, /latitude|longitude|planItem|itinerary/i);
  assert.doesNotMatch(html, /App Clip|appclip\.apple\.com|app-clip-bundle-id/i);
});

test('A creator name is escaped, and only the first name is used', async () => {
  plan.findUnique = async () => ({ ...proposed, creator: { name: '<img src=x onerror=alert(1)> Reed' } });
  const { html } = await get('plan-1');
  assert.doesNotMatch(html, /<img src=x/);
  assert.doesNotMatch(html, /onerror=alert/);
  // firstName keeps only the first token, which is then escaped.
  assert.match(html, /&lt;img invited you to a plan/);
  assert.doesNotMatch(html, /Reed/);
});

test('An Android or desktop visitor is told Bytspot is on iPhone, and still sees the plan', async () => {
  const android = await get('plan-1', 'Mozilla/5.0 (Linux; Android 14; Pixel 8) Chrome/120.0.0.0 Mobile Safari/537.36');
  assert.equal(android.status, 200);
  assert.match(android.html, /Rooftop then dinner/);
  assert.match(android.html, /Bytspot is on iPhone for now/);
  assert.doesNotMatch(android.html, /coming soon|coming to Android/i);

  const desktop = await get('plan-1', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/120.0.0.0 Safari/537.36');
  assert.match(desktop.html, /Bytspot is on iPhone for now/);
  assert.match(desktop.html, /Rooftop then dinner/);

  const iphone = await get('plan-1', 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1');
  assert.doesNotMatch(iphone.html, /Bytspot is on iPhone for now/);
  assert.match(iphone.html, /Open in Bytspot to see the plan/);
});

test('A cancelled plan and a missing plan render the same closed page, with a way forward and no plan detail', async () => {
  plan.findUnique = async () => ({ ...proposed, lifecycle: 'cancelled', cancelledAt: new Date() });
  const cancelled = await get('plan-1');
  plan.findUnique = async () => null;
  const missing = await get('plan-1');
  assert.equal(cancelled.status, 404);
  assert.equal(missing.status, 404);
  assert.equal(cancelled.html, missing.html);
  assert.match(cancelled.html, /isn&#39;t available/);
  assert.match(cancelled.html, /expired, been cancelled, or the plan may have ended/);
  assert.match(cancelled.html, /Get Bytspot on the App Store/);
  assert.doesNotMatch(cancelled.html, /Rooftop then dinner|Ava|Midtown/);
});
