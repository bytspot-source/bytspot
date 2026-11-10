import { Router, type Response } from 'express';
import { config } from '../config';
import { db } from '../lib/db';
import { captureError } from '../lib/observability';
import { shareLinkExpired, shareLinkExpiry } from '../trpc/partyRouter';
import {
  appStoreCta,
  escapeHtml,
  isInAppBrowserUA,
  openInBytspotCta,
  renderSharePage,
  renderShareShell,
  shareClient,
  shareFootnote,
} from '../lib/sharePage';

export { isInAppBrowserUA };

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
 *
 * A crawler is never authenticated, so this page may only ever carry what an
 * unauthenticated stranger is allowed to know. The venue is included only when
 * the host set disclosure to public — otherwise a forwarded link would render
 * the address in a message bubble and walk straight through the door policy.
 */

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

interface PublicParty {
  title: string; tagline: string; hostName: string;
  when: string; venue: string | null; disclosureNote: string; tier: string; access: string;
  coverUrl: string | null; shareUrl: string; userAgent: string | undefined;
}

function renderPage(party: PublicParty): string {
  const title = party.title;
  const host = party.hostName;
  // A host who cleared the subtitle meant to clear it. Reinstating the default
  // here put words back in their mouth that the editor had just taken out.
  const tagline = party.tagline;
  const description = `${host} · ${party.when}${party.venue ? ` · ${party.venue}` : ''}`;
  const chips = [party.tier.toUpperCase(), party.access, party.when]
    .map((chip) => `<span class="chip">${escapeHtml(chip)}</span>`).join('');
  const cover = party.coverUrl
    ? `<img class="cover" src="${escapeHtml(party.coverUrl)}" alt="">`
    : '<div class="cover cover--empty"></div>';
  const place = party.venue
    ? `<p class="venue">${escapeHtml(party.venue)}</p>`
    : `<p class="note">${escapeHtml(party.disclosureNote)}</p>`;
  const client = shareClient(party.userAgent);

  return renderSharePage({
    robotsNoIndex: true,
    documentTitle: `${title} · Bytspot`,
    description,
    ogTitle: title,
    ogDescription: description,
    shareUrl: party.shareUrl,
    ogImage: party.coverUrl,
    kicker: 'Party pass',
    heading: title,
    mediaHtml: cover,
    bodyHtml: `${tagline ? `<p class="tagline">${escapeHtml(tagline)}</p>\n` : ''}<p class="host">Hosted by ${escapeHtml(host)}</p>
<div class="chips">${chips}</div>
${place}`,
    ctas: [openInBytspotCta(party.shareUrl), appStoreCta()],
    footnote: shareFootnote(client, 'party'),
  });
}

/** A 500 must not claim the party is gone — only that Bytspot cannot answer. */
function renderUnavailable(): string {
  return renderShareShell("Bytspot can't load this right now", 'Please try again in a moment.');
}

function renderNotFound(): string {
  return renderShareShell(
    "This party pass isn't available",
    'The link may have expired, or the party may have ended.',
    { ctas: [appStoreCta()] },
  );
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
      // Hidden by reports, or hosted by a suspended account, reads as gone.
      where: { id: partyId, status: 'published', moderationHiddenAt: null, host: { suspendedAt: null } },
      // Only the media id is needed to build the cover URL. Selecting the row
      // wholesale would stream the image binary out of Postgres on every open.
      include: { host: { select: { name: true } }, media: { where: { kind: 'cover' }, take: 1, select: { id: true } } },
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
  // An approval door on Discover is reachable by strangers; its place waits for approval.
  const discoverListed = party.accessMode === 'private-approval' && party.showOnDiscover;
  const venue = party.locationDisclosure === 'public' && !discoverListed ? party.venueName : null;
  const html = renderPage({
    title: party.title,
    tagline: party.tagline,
    hostName: party.host.name ?? 'Bytspot Host',
    when: formatWhen(party.startsAt),
    venue,
    disclosureNote: discoverListed ? DISCLOSURE_NOTE['after-approval'] : (DISCLOSURE_NOTE[party.locationDisclosure] ?? DISCLOSURE_NOTE.withheld),
    tier: party.requiredMembershipTier,
    access: ACCESS_LABEL[party.accessMode] ?? party.accessMode,
    coverUrl: cover ? `${config.publicApiUrl}/media/parties/${encodeURIComponent(cover.id)}` : null,
    shareUrl: `${config.partyShareBaseUrl}/party/${encodeURIComponent(party.id)}`,
    userAgent: req.get('user-agent'),
  });

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  const ttl = cacheSeconds(party, venue !== null);
  res.setHeader('Cache-Control', ttl > 0 ? `public, max-age=${ttl}` : 'no-store');
  // The body now varies on User-Agent, so a shared cache must not hand an
  // in-app-browser variant to Safari (or the reverse).
  res.setHeader('Vary', 'User-Agent');
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
