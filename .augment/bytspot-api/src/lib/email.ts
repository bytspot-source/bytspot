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

const FROM = 'Bytspot <hello@bytspot.com>';

export async function sendWelcomeEmail(to: string, firstName: string): Promise<void> {
  const resend = getResend();
  if (!resend) return; // Silently skip if not configured

  const name = firstName || 'there';
  try {
    await resend.emails.send({
      from: FROM,
      to,
      subject: "You're in the Bytspot beta 🎉",
      html: `
        <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 480px; margin: 0 auto; background: #0d0d0d; color: #fff; border-radius: 16px; padding: 32px;">
          <div style="font-size: 32px; margin-bottom: 8px;">🎯</div>
          <h1 style="font-size: 24px; font-weight: 700; margin: 0 0 8px;">Hey ${name}, welcome to Bytspot!</h1>
          <p style="color: #aaa; font-size: 16px; line-height: 1.5; margin: 0 0 24px;">
            You're one of the first people to try the beta. Bytspot shows you live crowd levels,
            parking, and rides for Atlanta Midtown — so you always know what's happening before you go.
          </p>
          <a href="https://beta.bytspot.com" style="display: inline-block; background: #8b5cf6; color: #fff; font-weight: 700; font-size: 16px; padding: 14px 28px; border-radius: 12px; text-decoration: none;">
            Open Bytspot →
          </a>
          <p style="color: #555; font-size: 13px; margin-top: 32px;">
            Questions? Just reply to this email. We read everything.
          </p>
        </div>
      `,
    });
  } catch (err: any) {
    console.error('[email] sendWelcomeEmail failed:', err?.message);
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
          <a href="https://beta.bytspot.com/v/${venueSlug}" style="display: inline-block; background: #ef4444; color: #fff; font-weight: 700; font-size: 16px; padding: 14px 28px; border-radius: 12px; text-decoration: none;">
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

