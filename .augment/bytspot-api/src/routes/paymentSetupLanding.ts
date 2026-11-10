import { Router, type Response } from 'express';
import { hostPayoutPage } from './hostPayoutLanding';
import { captureError } from '../lib/observability';
import { completePaymentSetup, PAYMENT_SETUP_CANCEL_PATH, PAYMENT_SETUP_RETURN_PATH } from '../services/savedPaymentMethods';

const paymentSetupLandingRouter = Router();

/**
 * Where Stripe's hosted card setup sends a member back to. No Bytspot
 * credential arrives here, so the page shows nothing about the card: the app
 * reads the saved cards from `payments.listMethods` when it reopens.
 */
export const PAYMENT_METHODS_APP_URL = 'bytspot://profile/payment';

function send(res: Response, html: string) {
  res.set('Cache-Control', 'no-store');
  res.set('Referrer-Policy', 'no-referrer');
  res.type('html').send(html);
}

paymentSetupLandingRouter.get(PAYMENT_SETUP_RETURN_PATH, async (req, res) => {
  const sessionId = typeof req.query.session_id === 'string' ? req.query.session_id : '';
  let saved = false;
  try {
    saved = await completePaymentSetup(sessionId);
  } catch (error) {
    captureError(error, { route: PAYMENT_SETUP_RETURN_PATH });
  }
  send(res, saved
    ? hostPayoutPage('Card saved', 'Go back to Bytspot to see it in your payment methods.', PAYMENT_METHODS_APP_URL)
    : hostPayoutPage('Card setup finished', 'Go back to Bytspot to check your payment methods.', PAYMENT_METHODS_APP_URL));
});

paymentSetupLandingRouter.get(PAYMENT_SETUP_CANCEL_PATH, (_req, res) => {
  send(res, hostPayoutPage('No card added', 'Nothing was saved. Go back to Bytspot whenever you are ready.', PAYMENT_METHODS_APP_URL));
});

export default paymentSetupLandingRouter;
