import { TRPCError } from '@trpc/server';
import { Router, type Response } from 'express';
import { config } from '../config';
import { captureError } from '../lib/observability';
import { firstName, liveSale, photoUrl } from '../trpc/salesRouter';
import {
  appStoreCta,
  escapeHtml,
  openInBytspotCta,
  renderSharePage,
  renderShareShell,
  shareClient,
  shareFootnote,
} from '../lib/sharePage';

const saleLandingRouter = Router();

/**
 * Server-rendered Private Sale share page.
 *
 * Without it, /sale/<id> served the web app's home page, whose Smart App
 * Banner handed the app https://bytspot.app/ — no sale. This page names the
 * sale in the HTML (link previews never run JavaScript) and hands the banner
 * the sale URL itself.
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
  photoUrl: string | null; shareUrl: string; userAgent: string | undefined;
}

function renderPage(sale: PublicSale): string {
  const title = sale.title;
  const price = sale.price;
  const seller = sale.sellerName;
  const description = `${price} · from ${seller} · ${sale.window}`;
  const photo = sale.photoUrl ? escapeHtml(sale.photoUrl) : null;
  const client = shareClient(sale.userAgent);

  return renderSharePage({
    documentTitle: `${title} · Private Sale · Bytspot`,
    description,
    ogTitle: `${title} · ${price}`,
    ogDescription: `Private Sale from ${seller} · ${sale.window}`,
    shareUrl: sale.shareUrl,
    ogImage: sale.photoUrl,
    kicker: 'Private sale',
    heading: title,
    mediaHtml: photo ? `<img class="photo" src="${photo}" alt="">` : undefined,
    bodyHtml: `<p class="price">${escapeHtml(price)} · from ${escapeHtml(seller)}</p>
<div class="chips"><span class="chip">${escapeHtml(sale.window)}</span></div>
<p class="note">The seller shares the meet point only with buyers they approve. Get Bytspot to ask for it. Meet in a public place, check the item, then pay. Bytspot doesn't hold, move or protect money.</p>`,
    ctas: [openInBytspotCta(sale.shareUrl), appStoreCta()],
    footnote: shareFootnote(client, 'sale'),
  });
}

function sendShell(res: Response, status: number, heading: string, body: string, withStore = false) {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  return res.status(status).send(renderShareShell(heading, body, withStore ? { ctas: [appStoreCta()] } : undefined));
}

saleLandingRouter.get('/sale/:saleId', async (req, res) => {
  const saleId = req.params.saleId;
  if (saleId.length < 1 || saleId.length > 64) {
    return sendShell(res, 404, "This sale isn't available", 'This sale has ended or the link is no longer active.', true);
  }

  let sale;
  try {
    sale = await liveSale(saleId);
  } catch (err) {
    if (err instanceof TRPCError && err.code === 'NOT_FOUND') {
      return sendShell(res, 404, "This sale isn't available", 'This sale has ended or the link is no longer active.', true);
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
    userAgent: req.get('user-agent'),
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
