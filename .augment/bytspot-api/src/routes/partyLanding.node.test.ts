import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import express from 'express';
import partyLandingRouter from './partyLanding';
import { db } from '../lib/db';

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

async function get(partyId: string): Promise<{ status: number; html: string }> {
  const app = express();
  app.use(partyLandingRouter);
  const server = app.listen(0);
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/party/${partyId}`);
    return { status: res.status, html: await res.text() };
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
    assert.match(html, /revealed to approved guests/);
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
  assert.doesNotMatch(expired.html, /Champagne pop/);
});

test('A party title cannot inject markup into the page', async () => {
  party.findFirst = async () => ({ ...published, title: '</title><script>alert(1)</script>' });
  const { html } = await get('party-1');
  assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/);
  assert.match(html, /&lt;script&gt;/);
});
