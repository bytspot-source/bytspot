import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import express from 'express';
import helmet from 'helmet';
import partyLandingRouter from './partyLanding';
import { db } from '../lib/db';
import { config } from '../config';

const party = db.party as any;

const published = {
  id: 'party-1',
  status: 'published',
  title: 'Champagne pop',
  tagline: 'One moment. Your people.',
  startsAt: new Date(Date.now() + 60 * 60 * 1000),
  endsAt: new Date(Date.now() + 5 * 60 * 60 * 1000),
  shareLinkExpiresAt: null,
  venueName: 'The Roof, Midtown',
  locationDisclosure: 'public',
  accessMode: 'paid-ticket',
  requiredMembershipTier: 'green',
  host: { name: 'Ava Reed' },
  media: [],
};

async function get(partyId: string): Promise<{ status: number; html: string; csp: string | null; cache: string | null }> {
  const app = express();
  app.use(helmet());
  app.use(partyLandingRouter);
  const server = app.listen(0);
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/party/${partyId}`);
    return {
      status: res.status, html: await res.text(),
      csp: res.headers.get('content-security-policy'), cache: res.headers.get('cache-control'),
    };
  } finally {
    server.close();
  }
}

beforeEach(() => {
  party.findFirst = async () => published;
});

test('A shared link previews as the party, not as "Bytspot"', async () => {
  const { status, html } = await get('party-1');
  assert.equal(status, 200);
  // The crawler never runs JavaScript, so these must be in the response bytes.
  assert.match(html, /<meta property="og:title" content="Champagne pop">/);
  assert.match(html, /<meta property="og:description" content="Ava Reed[^"]*The Roof, Midtown">/);
  assert.match(html, /<title>Champagne pop · Bytspot<\/title>/);
});

test('The Smart App Banner opens the party, not the app root', async () => {
  const { html } = await get('party-1');
  const banner = /<meta name="apple-itunes-app" content="([^"]+)">/.exec(html)?.[1] ?? '';
  assert.match(banner, /app-argument=\S*\/party\/party-1/);
});

test('A withheld venue never reaches the preview', async () => {
  // after-approval and withheld rooms must not leak the address to a crawler,
  // because a forwarded link would render it without anyone being approved.
  for (const disclosure of ['after-approval', 'withheld']) {
    party.findFirst = async () => ({ ...published, locationDisclosure: disclosure });
    const { html } = await get('party-1');
    assert.doesNotMatch(html, /The Roof, Midtown/);
  }
});

test('An expired link is indistinguishable from a party that never existed', async () => {
  const ended = { ...published, startsAt: new Date(Date.now() - 8 * 60 * 60 * 1000), endsAt: new Date(Date.now() - 60 * 60 * 1000) };
  party.findFirst = async () => ended;
  const expired = await get('party-1');

  party.findFirst = async () => null;
  const missing = await get('does-not-exist');

  assert.equal(expired.status, 404);
  assert.equal(missing.status, 404);
  assert.equal(expired.html, missing.html);
  // Headers are part of the tell: a differing cache directive would
  // distinguish an expired party from one that never existed.
  assert.equal(expired.cache, 'no-store');
  assert.equal(missing.cache, 'no-store');
  assert.doesNotMatch(expired.html, /Champagne pop/);
});

test('The cover survives the global image policy, and scripts do not', async () => {
  party.findFirst = async () => ({ ...published, media: [{ id: 'media-1', kind: 'cover' }] });
  const { html, csp } = await get('party-1');
  // The page is served on the share domain; cover art comes from the API
  // origin, so `img-src 'self'` alone would blank it in a browser.
  assert.match(html, /<img class="cover" src="[^"]*\/media\/parties\/media-1"/);
  assert.ok(csp?.includes(`img-src 'self' data: ${config.publicApiUrl}`), csp ?? 'no CSP');
  assert.ok(csp?.includes("default-src 'none'"), csp ?? 'no CSP');
  assert.ok(!/script-src[^;]*unsafe/.test(csp ?? ''), csp ?? 'no CSP');
});

test('A party title cannot inject markup into the page', async () => {
  party.findFirst = async () => ({ ...published, title: '</title><script>alert(1)</script>' });
  const { html } = await get('party-1');
  assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/);
  assert.match(html, /&lt;script&gt;/);
});

test('A shared cache cannot answer 200 after the link has expired', async () => {
  // Cached one minute before expiry: a 300s TTL would keep serving the party
  // for four minutes after an unauthenticated caller must see a 404. Each
  // expiry source must cap the TTL, not just endsAt.
  const cases = [
    { label: 'endsAt', patch: { endsAt: new Date(Date.now() + 60 * 1000) } },
    { label: 'explicit shareLinkExpiresAt', patch: { endsAt: null, shareLinkExpiresAt: new Date(Date.now() + 45 * 1000) } },
    { label: 'startsAt + 6h fallback', patch: { startsAt: new Date(Date.now() - 6 * 60 * 60 * 1000 + 30 * 1000), endsAt: null } },
  ];
  for (const { label, patch } of cases) {
    party.findFirst = async () => ({ ...published, ...patch });
    const { status, cache } = await get('party-1');
    assert.equal(status, 200, label);
    const maxAge = Number(/max-age=(\d+)/.exec(cache ?? '')?.[1] ?? -1);
    assert.ok(maxAge > 0 && maxAge <= 60, `${label}: expected TTL capped by expiry, got ${cache}`);
  }

  // A link with an unbounded future still never exceeds the ceiling.
  party.findFirst = async () => ({ ...published, endsAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000) });
  assert.equal((await get('party-1')).cache, 'public, max-age=300');
});

test('A database outage says Bytspot is down, not that the party is gone', async () => {
  party.findFirst = async () => { throw new Error('connection terminated'); };
  const { status, html, cache } = await get('party-1');
  assert.equal(status, 500);
  assert.doesNotMatch(html, /isn't available/);
  assert.equal(cache, 'no-store');
});

test('A withheld location does not promise a reveal that never comes', async () => {
  party.findFirst = async () => ({ ...published, locationDisclosure: 'withheld' });
  const withheld = await get('party-1');
  assert.doesNotMatch(withheld.html, /revealed to approved guests/);
  assert.match(withheld.html, /not public/);

  party.findFirst = async () => ({ ...published, locationDisclosure: 'after-approval' });
  assert.match((await get('party-1')).html, /revealed to approved guests/);
});

test('An oversized party id never reaches the database', async () => {
  let queried = false;
  party.findFirst = async () => { queried = true; return published; };
  const { status } = await get('x'.repeat(400));
  assert.equal(status, 404);
  assert.equal(queried, false);
});

test('Every access mode renders a human label', async () => {
  for (const [mode, label] of [['free-rsvp', 'Free RSVP'], ['paid-ticket', 'Paid Ticket'], ['private-approval', 'Private Approval']]) {
    party.findFirst = async () => ({ ...published, accessMode: mode });
    const { html } = await get('party-1');
    assert.match(html, new RegExp(`<span class="chip">${label}</span>`), `${mode} must not render raw`);
  }
});
