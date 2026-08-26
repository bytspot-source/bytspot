import { Router, type Response } from 'express';
import { config } from '../config';
import { db } from '../lib/db';
import { captureError } from '../lib/observability';
import { shareLinkExpired, shareLinkExpiry } from '../trpc/partyRouter';

const partyLandingRouter = Router();

/**
 * Server-rendered share-link landing page.
 *
 * Link previews are the whole point of this route. iMessage, WhatsApp and
 * Instagram fetch the URL and read the bytes that come back — they do not run
 * JavaScript, so a client-side fetch renders the party for a human and leaves
 * every preview saying "Bytspot". The metadata has to be in the response.
 *
 * The page is one template with the party injected, not a file per party.
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

const ACCESS_LABEL: Record<string, string> = {
  'free-rsvp': 'Free RSVP',
  'paid-ticket': 'Paid Ticket',
  'private-approval': 'Private Approval',
};

/**
 * A withheld location is never revealed to anyone, so promising it "to
 * approved guests" would be a false statement in a forwarded chat. Only
 * after-approval rooms actually reveal on approval.
 */
const DISCLOSURE_NOTE: Record<string, string> = {
  'after-approval': 'Location is revealed to approved guests.',
  withheld: 'Location details are not public.',
};

// Shared caches must not outlive the share link: a page cached one second
// before expiry would otherwise keep answering 200 for another 5 minutes
// while a never-existed party answers 404, which is exactly the distinction
// the expiry rule exists to remove.
const MAX_CACHE_SECONDS = 300;

// A page that names the venue is the only one whose staleness can leak
// something. There is no purge path, so that window is bought down rather than
// assumed away: a host who tightens disclosure or unpublishes is exposed for a
// minute, not five. Pages with no venue keep the longer TTL, since going stale
// costs a guest nothing worse than an old title.
const VENUE_CACHE_SECONDS = 60;

function cacheSeconds(
  party: { shareLinkExpiresAt: Date | null; endsAt: Date | null; startsAt: Date },
  revealsVenue: boolean,
): number {
  const ceiling = revealsVenue ? VENUE_CACHE_SECONDS : MAX_CACHE_SECONDS;
  const remaining = Math.floor((shareLinkExpiry(party).getTime() - Date.now()) / 1000);
  return Math.max(0, Math.min(ceiling, remaining));
}

/**
 * A crawler is never authenticated, so this page may only ever carry what an
 * unapproved stranger is allowed to know. The venue is included only when the
 * host set disclosure to public — otherwise a forwarded link would render the
 * address in a message bubble and walk straight through the door policy.
 */
interface PublicParty {
  id: string; title: string; tagline: string; hostName: string;
  when: string; venue: string | null; disclosureNote: string; tier: string; access: string;
  coverUrl: string | null; shareUrl: string;
}

function renderPage(party: PublicParty): string {
  const title = escapeHtml(party.title);
  const host = escapeHtml(party.hostName);
  const tagline = escapeHtml(party.tagline || 'One moment. Your people.');
  const description = `${host} · ${escapeHtml(party.when)}${party.venue ? ` · ${escapeHtml(party.venue)}` : ''}`;
  const chips = [escapeHtml(party.tier.toUpperCase()), escapeHtml(party.access), escapeHtml(party.when)]
    .map((chip) => `<span class="chip">${chip}</span>`).join('');
  const cover = party.coverUrl
    ? `<img class="cover" src="${escapeHtml(party.coverUrl)}" alt="">`
    : '<div class="cover cover--empty"></div>';

  return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${title} · Bytspot</title>
<meta name="description" content="${description}">
<meta property="og:type" content="website">
<meta property="og:title" content="${title}">
<meta property="og:description" content="${description}">
<meta property="og:url" content="${escapeHtml(party.shareUrl)}">
${party.coverUrl ? `<meta property="og:image" content="${escapeHtml(party.coverUrl)}">` : ''}
<meta name="twitter:card" content="${party.coverUrl ? 'summary_large_image' : 'summary'}">
<meta name="twitter:title" content="${title}">
<meta name="twitter:description" content="${description}">
<!-- app-argument carries this party, so tapping the banner lands on the
     party rather than the app root. -->
<meta name="apple-itunes-app" content="app-id=6761876421, app-clip-bundle-id=com.bytspot.app.Clip, app-clip-display=card, app-argument=${escapeHtml(party.shareUrl)}">
<style>
:root{color-scheme:dark}
*{box-sizing:border-box;margin:0;padding:0}
body{background:#05070d;color:#fff;font:15px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
 min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px}
.card{width:100%;max-width:420px}
.brand{font-size:11px;font-weight:800;letter-spacing:.18em;color:#22d3a8;text-align:center;margin-bottom:14px}
.cover{width:100%;aspect-ratio:16/10;object-fit:cover;border-radius:20px;display:block}
.cover--empty{background:linear-gradient(135deg,#7c3aed,#db2777,#05070d)}
h1{font-size:30px;font-weight:900;line-height:1.1;margin:18px 0 6px}
.tagline{color:rgba(255,255,255,.62);font-weight:600}
.host{margin-top:14px;font-size:13px;font-weight:800;color:rgba(255,255,255,.9)}
.chips{display:flex;flex-wrap:wrap;gap:7px;margin-top:14px}
.chip{background:rgba(255,255,255,.08);border-radius:999px;padding:7px 13px;font-size:11px;font-weight:800;
 letter-spacing:.04em}
.venue{margin-top:12px;font-size:13px;font-weight:600;color:rgba(255,255,255,.68)}
.note{margin-top:12px;font-size:12px;font-weight:600;color:rgba(255,255,255,.45)}
.cta{display:block;margin-top:22px;background:#fff;color:#05070d;text-align:center;text-decoration:none;
 font-weight:900;font-size:16px;padding:16px;border-radius:16px}
</style>
</head><body><div class="card">
<div class="brand">BYTSPOT PARTY PASS</div>
${cover}
<h1>${title}</h1>
<p class="tagline">${tagline}</p>
<p class="host">Hosted by ${host}</p>
<div class="chips">${chips}</div>
${party.venue ? `<p class="venue">${escapeHtml(party.venue)}</p>` : `<p class="note">${escapeHtml(party.disclosureNote)}</p>`}
<a class="cta" href="${escapeHtml(party.shareUrl)}">Open in Bytspot</a>
<p class="note">Open on iPhone to see the Party Pass, RSVP, and your door status.</p>
</div></body></html>`;
}

function renderShell(heading: string, body: string, robots = true): string {
  return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Bytspot</title>
${robots ? '<meta name="robots" content="noindex">' : ''}
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

/** A 500 must not claim the party is gone — only that Bytspot cannot answer. */
function renderUnavailable(): string {
  return renderShell("Bytspot can't load this right now", 'Please try again in a moment.');
}

function renderNotFound(): string {
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
<h1>This Party Pass isn't available</h1>
<p>The link may have expired, or the party may have ended.</p>
</div></body></html>`;
}

function sendNotFound(res: Response) {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  return res.status(404).send(renderNotFound());
}

partyLandingRouter.get('/party/:partyId', async (req, res) => {
  const partyId = req.params.partyId;
  // Bound the key before it reaches the database. Generated IDs are well under
  // this, so anything longer is not a party that could exist and must not cost
  // a query — 404s are deliberately uncached, so misses always reach origin.
  if (partyId.length < 1 || partyId.length > 128) return sendNotFound(res);

  let party;
  try {
    party = await db.party.findFirst({
      where: { id: partyId, status: 'published' },
      include: { host: { select: { name: true } }, media: { where: { kind: 'cover' }, take: 1 } },
    });
  } catch (err) {
    // A database outage is not "this party does not exist". Telling a guest the
    // party is gone would be a lie, and it would hide the outage from Sentry.
    // Service health is not existence-revealing, so a generic 500 is safe.
    captureError(err, { route: 'party-landing' });
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    return res.status(500).send(renderUnavailable());
  }

  // An expired link must look the same as a party that never existed. The
  // guest-and-host exceptions cannot apply here: this response is cacheable
  // and the caller is unauthenticated, so it only ever renders the public view.
  if (!party || shareLinkExpired(party)) return sendNotFound(res);

  const cover = party.media[0];
  const venue = party.locationDisclosure === 'public' ? party.venueName : null;
  const html = renderPage({
    id: party.id,
    title: party.title,
    tagline: party.tagline,
    hostName: party.host.name ?? 'Bytspot Host',
    when: formatWhen(party.startsAt),
    venue,
    disclosureNote: DISCLOSURE_NOTE[party.locationDisclosure] ?? DISCLOSURE_NOTE.withheld,
    tier: party.requiredMembershipTier,
    access: ACCESS_LABEL[party.accessMode] ?? party.accessMode,
    coverUrl: cover ? `${config.publicApiUrl}/media/parties/${encodeURIComponent(cover.id)}` : null,
    shareUrl: `${config.partyShareBaseUrl}/party/${encodeURIComponent(party.id)}`,
  });

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  const ttl = cacheSeconds(party, venue !== null);
  res.setHeader('Cache-Control', ttl > 0 ? `public, max-age=${ttl}` : 'no-store');
  // The global helmet policy sets `img-src 'self'`, but this page is served on
  // the share domain while cover art is served from the API origin, so the
  // cover would be blocked for humans in a browser. Crawlers fetch og:image
  // server-side and are unaffected either way. Scripts stay denied outright:
  // the page is static markup and must never execute host-controlled text.
  res.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'none'",
      `img-src 'self' data: ${config.publicApiUrl}`,
      "style-src 'unsafe-inline'",
      "base-uri 'none'",
      "form-action 'none'",
      "frame-ancestors 'none'",
    ].join(';'),
  );
  return res.status(200).send(html);
});

export default partyLandingRouter;
