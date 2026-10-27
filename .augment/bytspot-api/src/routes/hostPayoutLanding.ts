import { Router, type Response } from 'express';
import { HOST_PAYOUT_REFRESH_PATH, HOST_PAYOUT_RETURN_PATH } from '../services/hostPayouts';

const hostPayoutLandingRouter = Router();

/**
 * Where Stripe's hosted onboarding sends a host back to. Stripe redirects here
 * without any Bytspot credential, so these pages show nothing about the account:
 * the app reads the real status from `payouts.host.status` when it reopens.
 */
export const APP_RETURN_URL = 'bytspot://payouts/host';

export function hostPayoutPage(title: string, body: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>${title} · Bytspot</title>
<style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#000;color:#fff;font:16px/1.5 -apple-system,system-ui,sans-serif;text-align:center;padding:24px}
a{display:inline-block;margin-top:20px;padding:12px 24px;border-radius:14px;background:#67e8f9;color:#000;font-weight:700;text-decoration:none}</style>
</head><body><main><h1>${title}</h1><p>${body}</p><a href="${APP_RETURN_URL}">Back to Bytspot</a></main></body></html>`;
}

function send(res: Response, html: string) {
  res.set('Cache-Control', 'no-store');
  res.set('Referrer-Policy', 'no-referrer');
  res.type('html').send(html);
}

hostPayoutLandingRouter.get(HOST_PAYOUT_RETURN_PATH, (_req, res) => {
  send(res, hostPayoutPage('Payout details sent', 'Stripe has your details. Go back to Bytspot to see whether payouts are on.'));
});

hostPayoutLandingRouter.get(HOST_PAYOUT_REFRESH_PATH, (_req, res) => {
  send(res, hostPayoutPage('That link expired', 'Go back to Bytspot and tap Set up payouts again to continue where you left off.'));
});

export default hostPayoutLandingRouter;
