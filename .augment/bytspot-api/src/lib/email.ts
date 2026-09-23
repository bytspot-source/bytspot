/**
 * Transactional email via Resend
 * Install: npm install resend
 * Set RESEND_API_KEY in Render env vars
 * Free tier: 3,000 emails/month
 */

import { config } from '../config';

let resendClient: any = null;

function getResend() {
  if (resendClient) return resendClient;
  if (!config.resendApiKey) return null;
  try {
    const { Resend } = require('resend');
    resendClient = new Resend(config.resendApiKey);
  } catch {
    console.warn('[email] resend package not installed');
  }
  return resendClient;
}

const FROM = 'Bytspot <hello@updates.bytspot.com>';

export async function sendWelcomeEmail(to: string, firstName: string): Promise<void> {
  const resend = getResend();
  if (!resend) return; // Silently skip if not configured

  const name = firstName || 'there';
  const welcomeUrl = `https://bytspot-beta.onrender.com/#/welcome?email=${encodeURIComponent(to)}`;
  try {
    await resend.emails.send({
      from: FROM,
      to,
      subject: `Welcome to Bytspot, ${name} 👋`,
      html: `
        <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 480px; margin: 0 auto; background: #0d0d0d; color: #fff; border-radius: 16px; padding: 32px;">
          <div style="font-size: 32px; margin-bottom: 8px;">🎯</div>
          <h1 style="font-size: 24px; font-weight: 700; margin: 0 0 8px;">Hey ${name}, welcome aboard.</h1>
          <p style="color: #aaa; font-size: 16px; line-height: 1.5; margin: 0 0 8px;">
            You're one of the first people in the Bytspot beta.
          </p>
          <p style="color: #aaa; font-size: 16px; line-height: 1.5; margin: 0 0 24px;">
            Know before you go — live crowd levels, open parking, and premium ride handoff for Atlanta Midtown, all in one place.
          </p>
          <a href="${welcomeUrl}" style="display: inline-block; background: linear-gradient(135deg, #8b5cf6, #06b6d4); color: #fff; font-weight: 700; font-size: 16px; padding: 14px 28px; border-radius: 12px; text-decoration: none;">
            Open Bytspot Beta →
          </a>
          <p style="color: #555; font-size: 13px; margin-top: 32px; line-height: 1.5;">
            Questions? Hit reply. We read every one.<br>— The Bytspot Team
          </p>
        </div>
      `,
    });
  } catch (err: any) {
    console.error('[email] sendWelcomeEmail failed:', err?.message);
  }
}

/**
 * Sent immediately when someone joins the waitlist via the beta funnel.
 * Short, warm, action-focused — links to the personalized /welcome page.
 */
export async function sendBetaLeadEmail(to: string, firstName: string): Promise<void> {
  const resend = getResend();
  if (!resend) return;

  const name = firstName || 'there';
  const welcomeUrl = `https://bytspot-beta.onrender.com/#/welcome?email=${encodeURIComponent(to)}`;
  console.log(`[email] sendBetaLeadEmail → ${to}`);
  try {
    await resend.emails.send({
      from: FROM,
      to,
      subject: `Your Bytspot early access is confirmed, ${name} 🎯`,
      html: `
        <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 480px; margin: 0 auto; background: #0d0d0d; color: #fff; border-radius: 16px; padding: 32px;">
          <p style="font-size: 28px; margin: 0 0 12px;">🎯</p>
          <h1 style="font-size: 22px; font-weight: 700; margin: 0 0 12px;">You're officially in, ${name}. 🎉</h1>
          <p style="color: #aaa; font-size: 15px; line-height: 1.6; margin: 0 0 20px;">
            Bytspot is <strong style="color: #fff">live in Atlanta Midtown right now</strong> — real-time crowd levels, open parking, and premium ride handoff, all before you leave home.
          </p>
          <a href="${welcomeUrl}" style="display: inline-block; background: linear-gradient(135deg, #8b5cf6, #06b6d4); color: #fff; font-weight: 700; font-size: 16px; padding: 14px 28px; border-radius: 12px; text-decoration: none;">
            Open Bytspot Beta →
          </a>
          <p style="color: #555; font-size: 13px; margin-top: 28px; line-height: 1.5;">
            Know someone in Midtown? Forward this — the first 100 members unlock free parking credit. 🚗
          </p>
          <p style="color: #444; font-size: 12px; margin-top: 12px;">
            Questions? Hit reply. We read every one.
          </p>
        </div>
      `,
    });
    console.log(`[email] ✅ sendBetaLeadEmail delivered to ${to}`);
  } catch (err: any) {
    console.error('[email] sendBetaLeadEmail failed:', err?.message);
  }
}

export async function sendCrowdAlertEmail(to: string, firstName: string, venueName: string, venueSlug: string): Promise<void> {
  const resend = getResend();
  if (!resend) return;

  const name = firstName || 'there';
  try {
    await resend.emails.send({
      from: FROM,
      to,
      subject: `🔴 ${venueName} is Packed right now`,
      html: `
        <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 480px; margin: 0 auto; background: #0d0d0d; color: #fff; border-radius: 16px; padding: 32px;">
          <div style="font-size: 32px; margin-bottom: 8px;">🔴</div>
          <h1 style="font-size: 22px; font-weight: 700; margin: 0 0 8px;">Hey ${name}, heads up!</h1>
          <p style="color: #aaa; font-size: 16px; line-height: 1.5; margin: 0 0 24px;">
            <strong style="color: #fff">${venueName}</strong>, one of your saved spots, just hit
            <strong style="color: #ef4444">Packed</strong> status. Plan ahead or check nearby alternatives.
          </p>
          <a href="https://bytspot-beta.onrender.com/#/welcome?email=${encodeURIComponent(to)}" style="display: inline-block; background: #ef4444; color: #fff; font-weight: 700; font-size: 16px; padding: 14px 28px; border-radius: 12px; text-decoration: none;">
            See ${venueName} →
          </a>
          <p style="color: #555; font-size: 13px; margin-top: 32px;">
            You're getting this because you saved ${venueName} in Bytspot. Manage alerts in your Profile settings.
          </p>
        </div>
      `,
    });
  } catch (err: any) {
    console.error('[email] sendCrowdAlertEmail failed:', err?.message);
  }
}

/** Whether a code can actually be delivered. Checked before a challenge is minted. */
export function mailerIsConfigured(): boolean {
  return Boolean(getResend());
}

/**
 * A vendor sign-in code.
 *
 * Unlike the rest of this file, a failure here is thrown rather than logged.
 * The others are notifications, and a dropped notification is a nuisance; this
 * one is the only way into the console, and swallowing it would return a
 * cheerful 200 to a vendor who will never receive anything.
 *
 * The email body is the one place the code exists in plaintext. It must not
 * also reach a log, a push, or an analytics event.
 */
export async function sendVendorSignInCode(to: string, code: string, ttlMins: number): Promise<void> {
  const resend = getResend();
  if (!resend) throw new Error('RESEND_API_KEY is not configured; cannot send a vendor sign-in code');

  await resend.emails.send({
    from: FROM,
    to,
    subject: `${code} is your Bytspot sign-in code`,
    html: `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 480px; margin: 0 auto; background: #0d0d0d; color: #fff; border-radius: 16px; padding: 32px;">
        <h1 style="font-size: 22px; font-weight: 700; margin: 0 0 8px;">Sign in to Bytspot</h1>
        <p style="color: #aaa; font-size: 16px; line-height: 1.5; margin: 0 0 24px;">
          Enter this code to open your business console. It expires in ${ttlMins} minutes.
        </p>
        <div style="font-size: 34px; font-weight: 700; letter-spacing: 8px; padding: 18px 0; text-align: center; background: #161616; border-radius: 12px;">
          ${code}
        </div>
        <p style="color: #555; font-size: 13px; margin-top: 32px;">
          If you did not try to sign in, you can ignore this email — nobody can use this code without it.
        </p>
      </div>
    `,
  });
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

export interface VendorAskNotice {
  title: string;
  placeLabel: string;
  partySize: number;
  when: string;
  note?: string | null;
}

/**
 * A guest asked one of a seller's windows. A notification, so a failure is
 * logged, not thrown: the ask is already in the seller's demand feed.
 * The note is guest-typed and is escaped before it reaches HTML.
 */
export async function sendVendorAskEmail(to: string[], ask: VendorAskNotice): Promise<void> {
  const resend = getResend();
  if (!resend || to.length === 0) return;

  const guests = `${ask.partySize} ${ask.partySize === 1 ? 'guest' : 'guests'}`;
  try {
    await resend.emails.send({
      from: FROM,
      to,
      subject: `New request: ${guests}, ${ask.when}`,
      html: `
        <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 480px; margin: 0 auto; background: #0d0d0d; color: #fff; border-radius: 16px; padding: 32px;">
          <h1 style="font-size: 22px; font-weight: 700; margin: 0 0 8px;">A guest is asking</h1>
          <p style="color: #ddd; font-size: 16px; line-height: 1.5; margin: 0 0 8px;">
            ${escapeHtml(ask.title)} at ${escapeHtml(ask.placeLabel)}: ${guests}, ${escapeHtml(ask.when)}.
          </p>
          ${ask.note ? `<p style="color: #aaa; font-size: 15px; line-height: 1.5; margin: 0 0 8px;">“${escapeHtml(ask.note)}”</p>` : ''}
          <p style="color: #aaa; font-size: 15px; line-height: 1.5; margin: 16px 0 0;">
            Open your Bytspot business console to offer the time or pass. The request expires if nobody answers.
          </p>
        </div>
      `,
    });
  } catch (err: any) {
    console.error('[email] sendVendorAskEmail failed:', err?.message);
  }
}

export interface GuestOfferNotice {
  where: string;
  when: string;
  price: string;
  holdUntil: string;
  terms?: string | null;
}

/**
 * A seller answered a guest's request with a held time. Logged, not thrown:
 * the offer stands whether or not the email lands. Seller-typed text is escaped.
 */
export async function sendGuestOfferEmail(to: string, offer: GuestOfferNotice): Promise<void> {
  const resend = getResend();
  if (!resend) return;

  try {
    await resend.emails.send({
      from: FROM,
      to,
      subject: `${offer.where} can take you ${offer.when}`,
      html: `
        <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 480px; margin: 0 auto; background: #0d0d0d; color: #fff; border-radius: 16px; padding: 32px;">
          <h1 style="font-size: 22px; font-weight: 700; margin: 0 0 8px;">${escapeHtml(offer.where)} answered</h1>
          <p style="color: #ddd; font-size: 16px; line-height: 1.5; margin: 0 0 8px;">
            ${escapeHtml(offer.when)} · ${escapeHtml(offer.price)}. They are holding it until ${escapeHtml(offer.holdUntil)}.
          </p>
          ${offer.terms ? `<p style="color: #aaa; font-size: 14px; line-height: 1.5; margin: 0 0 8px;">${escapeHtml(offer.terms)}</p>` : ''}
          <a href="${config.frontendUrl}" style="display: inline-block; margin-top: 16px; background: #00BFFF; color: #000; font-weight: 700; font-size: 16px; padding: 14px 28px; border-radius: 12px; text-decoration: none;">
            Open Bytspot to accept
          </a>
          <p style="color: #555; font-size: 13px; margin-top: 24px;">
            Profile → My Requests. Nothing is booked until you accept. Turn these off under Notifications → Email → Reservations.
          </p>
        </div>
      `,
    });
  } catch (err: any) {
    console.error('[email] sendGuestOfferEmail failed:', err?.message);
  }
}
