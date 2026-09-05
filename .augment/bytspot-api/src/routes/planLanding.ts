import { Router, type Response } from 'express';
import { config } from '../config';
import { db } from '../lib/db';
import { captureError } from '../lib/observability';
import { isInAppBrowserUA } from './partyLanding';

const planLandingRouter = Router();

const APP_STORE_ID = '6761876421';
const APP_STORE_URL = `https://apps.apple.com/app/id${APP_STORE_ID}`;

/**
 * Server-rendered Plan invite landing page.
 *
 * A creator invites someone who is not on Bytspot by sharing the Plan link
 * from their own device — Bytspot never sees the recipient's number, so the
 * social graph's "phone numbers are never accepted, stored, or returned" rule
 * holds. This page is what that link opens: it names the friend who invited
 * them and the Plan, and points at the App Store. Link previews (iMessage,
 * WhatsApp) read the response bytes and never run JavaScript, so the metadata
 * has to be in the HTML.
 *
 * There is deliberately no /plan/* Universal Link: the app has no in-app plan
 * router yet, so every tap should reach this page (installed users get the
 * Smart App Banner's "Open"), not a dead deep link.
 */

const ESCAPES: Record<string, string> = {
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
};

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ESCAPES[char]);
}

function formatWhen(startsAt: Date): string {
  return new Intl.DateTimeFormat('en-US', {
    weekday: 'short', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
  }).format(startsAt);
}

// A Plan without a set time is a real state, not a gap to paper over. The
// creator may not have picked one; the page says so rather than inventing it.
const WHEN_TBD = 'When TBD';

// The first name only. The invite is warm, not a directory entry, and the
// creator's surname is not something a link-holder needs.
function firstName(name: string | null | undefined): string {
  const trimmed = (name ?? '').trim();
  if (!trimmed) return 'A friend';
  return trimmed.split(/\s+/)[0];
}

// A cancelled, expired, or finished Plan must read the same as one that never
// existed — the link is closed. Membership-only detail (who is going, the
// intent, the area coordinates) is never on this page: an unauthenticated
// stranger with the link may only ever see the friend's first name, the
// title, and the rough when/where the creator chose to share.
function planLinkClosed(
  plan: { lifecycle: string; endsAt: Date | null; expiresAt: Date | null },
  now: Date,
): boolean {
  if (plan.lifecycle === 'cancelled') return true;
  // A proposed Plan that ran out of time is expired on read; there is no sweep.
  if (plan.lifecycle === 'proposed' && plan.expiresAt && now >= plan.expiresAt) return true;
  if (plan.lifecycle === 'confirmed' && plan.endsAt && now >= plan.endsAt) return true;
  return false;
}

interface PublicPlan {
  hostName: string; title: string; when: string; area: string | null;
  shareUrl: string; isInAppBrowser: boolean;
}

function renderPage(plan: PublicPlan): string {
  const host = escapeHtml(plan.hostName);
  const title = escapeHtml(plan.title);
  const heading = `${host} invited you to a plan`;
  const meta = [escapeHtml(plan.when), plan.area ? escapeHtml(plan.area) : null].filter(Boolean).join(' · ');
  const description = `${title} · ${meta}`;

  return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${heading} · Bytspot</title>
<meta name="description" content="${description}">
<meta property="og:type" content="website">
<meta property="og:title" content="${heading}">
<meta property="og:description" content="${description}">
<meta property="og:url" content="${escapeHtml(plan.shareUrl)}">
<meta name="twitter:card" content="summary">
<meta name="twitter:title" content="${heading}">
<meta name="twitter:description" content="${description}">
<!-- app-id only: there is no Plan App Clip, so the banner offers Open (when
     installed) or Get, and app-argument carries the Plan for a future router. -->
<meta name="apple-itunes-app" content="app-id=${APP_STORE_ID}, app-argument=${escapeHtml(plan.shareUrl)}">
<style>
:root{color-scheme:dark}
*{box-sizing:border-box;margin:0;padding:0}
body{background:#05070d;color:#fff;font:15px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
 min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px}
.card{width:100%;max-width:420px}
.brand{font-size:11px;font-weight:800;letter-spacing:.18em;color:#22d3a8;text-align:center;margin-bottom:18px}
.kicker{font-size:13px;font-weight:800;color:rgba(255,255,255,.62)}
h1{font-size:30px;font-weight:900;line-height:1.12;margin:6px 0 14px}
.chips{display:flex;flex-wrap:wrap;gap:7px;margin-top:4px}
.chip{background:rgba(255,255,255,.08);border-radius:999px;padding:7px 13px;font-size:11px;font-weight:800;
 letter-spacing:.04em}
.note{margin-top:16px;font-size:13px;font-weight:600;color:rgba(255,255,255,.55)}
.cta{display:block;margin-top:22px;background:#fff;color:#05070d;text-align:center;text-decoration:none;
 font-weight:900;font-size:16px;padding:16px;border-radius:16px}
.foot{margin-top:12px;font-size:12px;font-weight:600;color:rgba(255,255,255,.45);text-align:center}
</style>
</head><body><div class="card">
<div class="brand">BYTSPOT</div>
<p class="kicker">${host} invited you to a plan</p>
<h1>${title}</h1>
<div class="chips"><span class="chip">${escapeHtml(plan.when)}</span>${plan.area ? `<span class="chip">${escapeHtml(plan.area)}</span>` : ''}</div>
<p class="note">You're being invited — you decide if you're in. Bytspot is where the plan lives: see the details and RSVP.</p>
<a class="cta" href="${escapeHtml(APP_STORE_URL)}">Get Bytspot</a>
${plan.isInAppBrowser
  ? `<p class="foot">This in-app browser can't open the App Store. Tap ⋯ and choose "Open in Safari".</p>`
  : `<p class="foot">Open on iPhone to see the plan and say if you're in.</p>`}
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

/** A 500 must not claim the Plan is gone — only that Bytspot cannot answer. */
function sendUnavailable(res: Response) {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  return res.status(500).send(renderShell("Bytspot can't load this right now", 'Please try again in a moment.'));
}

function sendNotFound(res: Response) {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  return res.status(404).send(renderShell("This plan invite isn't available", 'The link may have been cancelled, or the plan may have ended.'));
}

planLandingRouter.get('/plan/:planId', async (req, res) => {
  const planId = req.params.planId;
  // Bound the key before it reaches the database. Generated IDs are well under
  // this, so anything longer is not a Plan that could exist and must not cost a
  // query — 404s are deliberately uncached, so misses always reach origin.
  if (planId.length < 1 || planId.length > 128) return sendNotFound(res);

  let plan;
  try {
    plan = await db.plan.findUnique({
      where: { id: planId },
      select: {
        id: true, title: true, startsAt: true, endsAt: true, areaLabel: true,
        lifecycle: true, expiresAt: true, creator: { select: { name: true } },
      },
    });
  } catch (err) {
    // A database outage is not "this Plan does not exist". Saying the invite is
    // gone would be a lie and would hide the outage from Sentry.
    captureError(err, { route: 'plan-landing' });
    return sendUnavailable(res);
  }

  // A closed link reads the same as a Plan that never existed.
  if (!plan || planLinkClosed(plan, new Date())) return sendNotFound(res);

  const html = renderPage({
    hostName: firstName(plan.creator.name),
    title: plan.title,
    when: plan.startsAt ? formatWhen(plan.startsAt) : WHEN_TBD,
    area: plan.areaLabel,
    shareUrl: `${config.partyShareBaseUrl}/plan/${encodeURIComponent(plan.id)}`,
    isInAppBrowser: isInAppBrowserUA(req.get('user-agent')),
  });

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  // Short TTL so a cancelled or edited Plan stops previewing quickly; the body
  // varies on User-Agent (in-app-browser copy), so a shared cache must not hand
  // one variant to the other.
  res.setHeader('Cache-Control', 'public, max-age=60');
  res.setHeader('Vary', 'User-Agent');
  // Static markup only — no images, no scripts. The page must never execute
  // creator-controlled text.
  res.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'none'",
      "style-src 'unsafe-inline'",
      "base-uri 'none'",
      "form-action 'none'",
      "frame-ancestors 'none'",
    ].join(';'),
  );
  return res.status(200).send(html);
});

export default planLandingRouter;
