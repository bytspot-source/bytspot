import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import express from 'express';
import helmet from 'helmet';
import saleLandingRouter, { priceLabel } from './saleLanding';
import { db } from '../lib/db';

const privateSale = db.privateSale as any;

const open = {
  id: 'sale-1',
  sellerId: 'seller-1',
  title: 'Vintage denim jacket',
  priceCents: 4500,
  status: 'open',
  windowStart: new Date(Date.now() + 60 * 60 * 1000),
  windowEnd: new Date(Date.now() + 3 * 60 * 60 * 1000),
  meetName: 'Ponce City Market',
  meetAreaLabel: 'Old Fourth Ward',
  meetLat: 33.7726,
  meetLng: -84.3655,
  seller: { name: 'Ava Reed' },
  photo: { id: 'photo-1' },
};

let lastWhere: any;

async function get(saleId: string, userAgent?: string) {
  const app = express();
  app.use(helmet());
  app.use(saleLandingRouter);
  const server = app.listen(0);
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/sale/${saleId}`, { headers: userAgent ? { 'user-agent': userAgent } : {} });
    return { status: res.status, html: await res.text(), csp: res.headers.get('content-security-policy'), cache: res.headers.get('cache-control') };
  } finally {
    server.close();
  }
}

beforeEach(() => {
  lastWhere = undefined;
  privateSale.findFirst = async (args: any) => { lastWhere = args.where; return open; };
});

test('The sale page hands the App Clip the sale link, never the home page', async () => {
  const { status, html, csp, cache } = await get('sale-1');
  assert.equal(status, 200);
  assert.match(html, /app-clip-bundle-id=com\.bytspot\.app\.Clip, app-clip-display=card, app-argument=https:\/\/bytspot\.app\/sale\/sale-1"/);
  assert.doesNotMatch(html, /app-argument=https:\/\/bytspot\.app\/"/);
  assert.match(html, /PRIVATE SALE/);
  assert.match(html, /Vintage denim jacket/);
  assert.match(html, /\$45 · from Ava/);
  assert.match(html, /og:image" content="[^"]*\/media\/sales\/photo-1"/);
  assert.doesNotMatch(html, /Party Pass|Black/);
  assert.match(csp ?? '', /default-src 'none'/);
  assert.doesNotMatch(csp ?? '', /script-src/);
  assert.equal(cache, 'private, no-store');
});

test('A link-holder sees only the first name and never the meet point or area', async () => {
  const { html } = await get('sale-1');
  assert.doesNotMatch(html, /Reed/);
  assert.doesNotMatch(html, /Ponce City Market|Old Fourth Ward|33\.77|-84\.36/);
});

test('Only a live sale is served', async () => {
  await get('sale-1');
  assert.equal(lastWhere.status, 'open');
  assert.ok(lastWhere.windowEnd.gt instanceof Date);
  assert.equal(lastWhere.moderationHiddenAt, null);
  privateSale.findFirst = async () => null;
  const { status, html } = await get('sale-1');
  assert.equal(status, 404);
  assert.match(html, /This sale has ended or the link is no longer active/);
  assert.doesNotMatch(html, /apple-itunes-app/);
});

test('A database failure is not reported as an ended sale', async () => {
  privateSale.findFirst = async () => { throw new Error('db down'); };
  const { status, html } = await get('sale-1');
  assert.equal(status, 500);
  assert.match(html, /can't load this right now/);
});

test('Seller-controlled text is escaped, never executed', async () => {
  privateSale.findFirst = async () => ({ ...open, title: '<script>alert(1)</script>', photo: null });
  const { html } = await get('sale-1');
  assert.doesNotMatch(html, /<script>alert/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(html, /og:image/);
});

test('An over-long id is refused before the database', async () => {
  let called = false;
  privateSale.findFirst = async () => { called = true; return open; };
  const { status } = await get('x'.repeat(65));
  assert.equal(status, 404);
  assert.equal(called, false);
});

test('Prices read like the app', () => {
  assert.equal(priceLabel(4500), '$45');
  assert.equal(priceLabel(4550), '$45.50');
});
