import { TRPCError } from '@trpc/server';
import { Router, type Response } from 'express';
import { config } from '../config';
import { captureError } from '../lib/observability';
import { isInAppBrowserUA } from './partyLanding';
import { APP_STORE_ID, APP_STORE_URL, escapeHtml } from './planLanding';
import { firstName, liveSale, photoUrl } from '../trpc/salesRouter';

const saleLandingRouter = Router();

const CLIP_BUNDLE_ID = 'com.bytspot.app.Clip';

/**
 * Server-rendered Private Sale share page.
 *
 * Without it, /sale/<id> served the web app's home page, whose Smart App
 * Banner handed the App Clip https://bytspot.app/ — no sale, so the Clip fell
 * back to a vendor catalog. This page names the sale in the HTML (link
 * previews never run JavaScript) and hands the Clip the sale URL itself.
 *
 * Only what `sales.view` shows a signed-out viewer: title, price, the
 * seller's first name, the window and the photo. Never the meet point or the
 * area; those stay in the app for buyers the seller approves.
 */

function formatWindow(start: Date, end: Date): string {
  const day = new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
  const time = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit' });
  const endTime = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });
  return `${day.format(start)} · ${time.format(start)}–${endTime.format(end)}`;
}

export function priceLabel(cents: number): string {
  const dollars = cents / 100;
  return Number.isInteger(dollars) ? `$${dollars}` : `$${dollars.toFixed(2)}`;
}

interface PublicSale {
  title: string; price: string; sellerName: string; window: string;
  photoUrl: string | null; shareUrl: string; isInAppBrowser: boolean;
}

function renderPage(sale: PublicSale): string {
  const title = escapeHtml(sale.title);
  const price = escapeHtml(sale.price);
  const seller = escapeHtml(sale.sellerName);
  const description = `${price} · from ${seller} · ${escapeHtml(sale.window)}`;
  const photo = sale.photoUrl ? escapeHtml(sale.photoUrl) : null;

  return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${title} · Private Sale · Bytspot</title>
<meta name="description" content="${description}">
<meta property="og:type" content="website">
<meta property="og:title" content="${title} · ${price}">
<meta property="og:description" content="Private Sale from ${seller} · ${escapeHtml(sale.window)}">
<meta property="og:url" content="${escapeHtml(sale.shareUrl)}">
${photo ? `<meta property="og:image" content="${photo}">\n` : ''}<meta name="twitter:card" content="${photo ? 'summary_large_image' : 'summary'}">
<meta name="twitter:title" content="${title} · ${price}">
<meta name="twitter:description" content="Private Sale from ${seller}">
<meta name="apple-itunes-app" content="app-id=${APP_STORE_ID}, app-clip-bundle-id=${CLIP_BUNDLE_ID}, app-clip-display=card, app-argument=${escapeHtml(sale.shareUrl)}">
<style>
:root{color-scheme:dark}
*{box-sizing:border-box;margin:0;padding:0}
body{background:#05070d;color:#fff;font:15px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
 min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px}
.card{width:100%;max-width:420px}
.brand{font-size:11px;font-weight:800;letter-spacing:.18em;color:#22d3a8;text-align:center;margin-bottom:18px}
.photo{width:100%;aspect-ratio:4/3;object-fit:cover;border-radius:20px;margin-bottom:16px;background:rgba(255,255,255,.06)}
.kicker{font-size:11px;font-weight:900;letter-spacing:.16em;color:rgba(255,255,255,.62)}
h1{font-size:28px;font-weight:900;line-height:1.15;margin:6px 0 6px}
.price{font-size:18px;font-weight:900;color:#22d3ee}
.chips{display:flex;flex-wrap:wrap;gap:7px;margin-top:12px}
.chip{background:rgba(255,255,255,.08);border-radius:999px;padding:7px 13px;font-size:11px;font-weight:800;letter-spacing:.04em}
.note{margin-top:16px;font-size:13px;font-weight:600;color:rgba(255,255,255,.55)}
.cta{display:block;margin-top:22px;background:#fff;color:#05070d;text-align:center;text-decoration:none;
 font-weight:900;font-size:16px;padding:16px;border-radius:16px}
.foot{margin-top:12px;font-size:12px;font-weight:600;color:rgba(255,255,255,.45);text-align:center}
</style>
</head><body><div class="card">
<div class="brand">BYTSPOT</div>
${photo ? `<img class="photo" src="${photo}" alt="">\n` : ''}<p class="kicker">PRIVATE SALE</p>
<h1>${title}</h1>
<p class="price">${price} · from ${seller}</p>
<div class="chips"><span class="chip">${escapeHtml(sale.window)}</span></div>
<p class="note">The seller shares the meet point only with buyers they approve. Get Bytspot to ask for it. Meet in a public place, check the item, then pay. Bytspot doesn't hold, move or protect money.</p>
<a class="cta" href="${escapeHtml(APP_STORE_URL)}">Get Bytspot to request</a>
${sale.isInAppBrowser
  ? `<p class="foot">This in-app browser can't open the App Store. Tap ⋯ and choose "Open in Safari".</p>`
  : `<p class="foot">Open on iPhone to see the sale and ask the seller.</p>`}
</div></body></html>`;
}

function renderShell(heading: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Bytspot</title>
<meta name="robots" content="noindex">
<style>
:root{color-scheme:dark}
body{background:#05070d;color:#fff;font:15px/1.5 -apple-system,BlinkMacSystemFont,sans-serif;
 min-height:100vh;display:flex;align-items:center;justify-content:center;text-align:center;padding:24px;margin:0}
h1{font-size:22px;font-weight:900;margin:0 0 8px}
p{color:rgba(255,255,255,.55);font-weight:600;margin:0}
</style>
</head><body><div>
<h1>${heading}</h1>
<p>${body}</p>
</div></body></html>`;
}

function sendShell(res: Response, status: number, heading: string, body: string) {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  return res.status(status).send(renderShell(heading, body));
}

saleLandingRouter.get('/sale/:saleId', async (req, res) => {
  const saleId = req.params.saleId;
  if (saleId.length < 1 || saleId.length > 64) {
    return sendShell(res, 404, "This sale isn't available", 'This sale has ended or the link is no longer active.');
  }

  let sale;
  try {
    sale = await liveSale(saleId);
  } catch (err) {
    if (err instanceof TRPCError && err.code === 'NOT_FOUND') {
      return sendShell(res, 404, "This sale isn't available", 'This sale has ended or the link is no longer active.');
    }
    captureError(err, { route: 'sale-landing' });
    return sendShell(res, 500, "Bytspot can't load this right now", 'Please try again in a moment.');
  }

  const html = renderPage({
    title: sale.title,
    price: priceLabel(sale.priceCents),
    sellerName: firstName(sale.seller.name),
    window: formatWindow(sale.windowStart, sale.windowEnd),
    photoUrl: photoUrl(sale.photo),
    shareUrl: `${config.partyShareBaseUrl}/sale/${encodeURIComponent(sale.id)}`,
    isInAppBrowser: isInAppBrowserUA(req.get('user-agent')),
  });

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  // A closed, sold or hidden sale must not linger in a shared cache.
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('Vary', 'User-Agent');
  res.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'none'",
      "style-src 'unsafe-inline'",
      `img-src ${config.publicApiUrl}`,
      "base-uri 'none'",
      "form-action 'none'",
      "frame-ancestors 'none'",
    ].join(';'),
  );
  return res.status(200).send(html);
});

export default saleLandingRouter;
