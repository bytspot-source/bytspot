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
            Know before you go — live crowd levels, open parking, and ride ETAs for Atlanta Midtown, all in one place.
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

export async function sendPasswordResetEmail(to: string, firstName: string, resetUrl: string): Promise<void> {
  const resend = getResend();
  if (!resend) return;

  const name = firstName || 'there';
  try {
    await resend.emails.send({
      from: FROM,
      to,
      subject: 'Reset your Bytspot password',
      html: `
        <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 480px; margin: 0 auto; background: #0d0d0d; color: #fff; border-radius: 16px; padding: 32px;">
          <div style="font-size: 32px; margin-bottom: 8px;">🔐</div>
          <h1 style="font-size: 24px; font-weight: 700; margin: 0 0 8px;">Reset your password, ${name}</h1>
          <p style="color: #aaa; font-size: 16px; line-height: 1.5; margin: 0 0 24px;">
            We received a request to reset your Bytspot password. This link expires in 1 hour and can only be used once.
          </p>
          <a href="${resetUrl}" style="display: inline-block; background: linear-gradient(135deg, #8b5cf6, #06b6d4); color: #fff; font-weight: 700; font-size: 16px; padding: 14px 28px; border-radius: 12px; text-decoration: none;">
            Reset Password →
          </a>
          <p style="color: #555; font-size: 13px; margin-top: 32px; line-height: 1.5;">
            If you didn't request this, you can safely ignore this email.<br>— The Bytspot Team
          </p>
        </div>
      `,
    });
  } catch (err: any) {
    console.error('[email] sendPasswordResetEmail failed:', err?.message);
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
            Bytspot is <strong style="color: #fff">live in Atlanta Midtown right now</strong> — real-time crowd levels, open parking, and ride ETAs, all before you leave home.
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

