import { Router, type Response } from 'express';
import { config } from '../config';
import { db } from '../lib/db';
import { captureError } from '../lib/observability';
import { planEffectiveEnd } from '../trpc/planRouter';
import {
  APP_STORE_ID,
  APP_STORE_URL,
  appStoreCta,
  escapeHtml,
  openInBytspotCta,
  renderSharePage,
  renderShareShell,
  shareClient,
  shareFootnote,
} from '../lib/sharePage';

export { APP_STORE_ID, APP_STORE_URL, escapeHtml };

const planLandingRouter = Router();

/**
 * Server-rendered Plan invite landing page.
 *
 * A creator invites someone who is not on Bytspot by sharing the Plan link
 * from their own device — Bytspot never sees the recipient's number, so the
 * social graph's "phone numbers are never accepted, stored, or returned" rule
 * holds. This page is what that link opens: it names the friend who invited
 * them and the Plan, and points at the app. Link previews (iMessage,
 * WhatsApp) read the response bytes and never run JavaScript, so the metadata
 * has to be in the HTML.
 *
 * /plan/<id> is now a Universal Link: on a device with the app it opens the
 * in-app join sheet directly. This page is the fallback when the app is not
 * installed. The invite carries the Plan's bearer join token in `t`; when it
 * is present it rides into the Smart App Banner's app-argument and the share
 * URL, so an installed "Open" — or a re-tap after install — seats the holder.
 * A token-bearing response is never cached: it carries a credential.
 *
 * Membership-only detail (who is going, the itinerary stops, the intent, the
 * area coordinates) is never on this page: an unauthenticated stranger with
 * the link may only ever see the friend's first name, the title, and the
 * rough when/where the creator chose to share.
 */

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

// A deleted, cancelled, expired, or finished Plan reads the same as one that never
// existed — the link is closed.
function planLinkClosed(
  plan: { lifecycle: string; startsAt: Date | null; endsAt: Date | null; expiresAt: Date | null; deletedAt: Date | null },
  now: Date,
): boolean {
  if (plan.deletedAt || plan.lifecycle === 'cancelled') return true;
  // A proposed Plan that ran out of time is expired on read; there is no sweep.
  if (plan.lifecycle === 'proposed' && plan.expiresAt && now >= plan.expiresAt) return true;
  const end = planEffectiveEnd(plan);
  if (plan.lifecycle === 'confirmed' && end && now >= end) return true;
  return false;
}

interface PublicPlan {
  hostName: string; title: string; when: string; area: string | null;
  shareUrl: string; userAgent: string | undefined; hasToken: boolean;
}

function renderPage(plan: PublicPlan): string {
  const host = plan.hostName;
  const title = plan.title;
  const heading = `${host} invited you to a plan`;
  const meta = [plan.when, plan.area].filter(Boolean).join(' · ');
  const description = `${title} · ${meta}`;
  const client = shareClient(plan.userAgent);
  const whenChip = `<span class="chip">${escapeHtml(plan.when)}</span>`;
  const areaChip = plan.area ? `<span class="chip">${escapeHtml(plan.area)}</span>` : '';

  return renderSharePage({
    robotsNoIndex: true,
    documentTitle: `${heading} · Bytspot`,
    description,
    ogTitle: heading,
    ogDescription: description,
    shareUrl: plan.shareUrl,
    kicker: heading,
    heading: title,
    bodyHtml: `<div class="chips">${whenChip}${areaChip}</div>
<p class="note">You're being invited — you decide if you're in. Bytspot is where the plan lives: see the details and RSVP.</p>`,
    ctas: [openInBytspotCta(plan.shareUrl), appStoreCta()],
    footnote: shareFootnote(client, plan.hasToken ? 'plan-token' : 'plan'),
  });
}

/** A 500 must not claim the Plan is gone — only that Bytspot cannot answer. */
function sendUnavailable(res: Response) {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  return res.status(500).send(renderShareShell("Bytspot can't load this right now", 'Please try again in a moment.'));
}

function sendNotFound(res: Response) {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  return res.status(404).send(renderShareShell(
    "This plan invite isn't available",
    'The link may have expired, been cancelled, or the plan may have ended.',
    { ctas: [appStoreCta()] },
  ));
}

planLandingRouter.get('/plan/:planId', async (req, res) => {
  const planId = req.params.planId;
  // The bearer join token, when the invite carries one. It is the app's
  // credential, not this page's — the server never validates or stores it, only
  // reflects it back into the app hand-off. Bound to the same ceiling the native
  // router enforces; anything else is treated as a token-less preview.
  const rawToken = typeof req.query.t === 'string' ? req.query.t.trim() : '';
  const token = rawToken.length >= 1 && rawToken.length <= 200 ? rawToken : undefined;
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
        lifecycle: true, expiresAt: true, deletedAt: true, creator: { select: { name: true } },
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

  const base = `${config.partyShareBaseUrl}/plan/${encodeURIComponent(plan.id)}`;
  const html = renderPage({
    hostName: firstName(plan.creator.name),
    title: plan.title,
    when: plan.startsAt ? formatWhen(plan.startsAt) : WHEN_TBD,
    area: plan.areaLabel,
    shareUrl: token ? `${base}?t=${encodeURIComponent(token)}` : base,
    userAgent: req.get('user-agent'),
    hasToken: Boolean(token),
  });

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  // Neither previews nor credential-bearing pages may outlive deletion in a
  // shared cache. Every new request must revalidate the Plan's tombstone.
  res.setHeader('Cache-Control', 'private, no-store');
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
