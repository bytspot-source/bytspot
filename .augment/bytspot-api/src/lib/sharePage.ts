/**
 * Shared chrome for plan, party, and sale share-link landing pages.
 *
 * These pages are server-rendered and script-free: link previews never run
 * JavaScript, so titles, descriptions and images have to be in the HTML.
 * The look matches the bytspot.com redesign — night navy, cyan, bone, and a
 * CSS-only starfield that stops when the visitor prefers reduced motion.
 *
 * A same-domain "Open in Bytspot" link cannot hand off to the installed app
 * from this page (iOS will not follow a Universal Link to the page's own
 * domain). The Smart App Banner still can, via app-id and app-argument, and
 * the App Store button is the path for anyone who does not have the app yet.
 */

export const APP_STORE_ID = '6761876421';
export const APP_STORE_URL = `https://apps.apple.com/app/id${APP_STORE_ID}`;
export const MARKETING_URL = 'https://bytspot.com/';

const ESCAPES: Record<string, string> = {
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
};

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ESCAPES[char]);
}

/**
 * Snapchat, Instagram, TikTok and Facebook render links in an embedded
 * WKWebView where Universal Links never fire and the Smart App Banner is not
 * shown. Detected from the User-Agent server-side: these pages stay script-free.
 */
export function isInAppBrowserUA(userAgent: string | undefined): boolean {
  if (!userAgent) return false;
  return /Snapchat|Instagram|TikTok|musical_ly|FBAN|FBAV|FB_IAB|Line\/|Twitter|Pinterest/i.test(userAgent);
}

export type ShareClient = 'in-app-browser' | 'ios' | 'android' | 'other';

/**
 * Classify the visitor from the User-Agent. A missing UA is treated as iOS:
 * these links are usually opened from iMessage, and some preview fetches
 * omit a useful UA. Only clearly Android or desktop UAs get the "on iPhone
 * for now" note, so we never invent an Android date or promise.
 */
export function shareClient(userAgent: string | undefined): ShareClient {
  if (isInAppBrowserUA(userAgent)) return 'in-app-browser';
  const ua = userAgent ?? '';
  if (!ua) return 'ios';
  if (/iPhone|iPod|iPad|CPU (iPhone )?OS|CriOS|FxiOS/i.test(ua)) return 'ios';
  if (/Android/i.test(ua)) return 'android';
  if (/Windows|Macintosh|Linux|CrOS|X11/i.test(ua)) return 'other';
  return 'ios';
}

export type ShareFootnoteKind = 'plan' | 'plan-token' | 'party' | 'sale';

export function shareFootnote(client: ShareClient, kind: ShareFootnoteKind): string {
  if (client === 'in-app-browser') {
    return 'This in-app browser can\'t open Bytspot. Tap ⋯ and choose "Open in Safari".';
  }
  if (client === 'android' || client === 'other') {
    return 'Bytspot is on iPhone for now. The details on this page are still right.';
  }
  if (kind === 'plan-token') return 'Get Bytspot, then reopen this invite to take your seat.';
  if (kind === 'plan') return "Open in Bytspot to see the plan and say if you're in.";
  if (kind === 'party') return 'Open in Bytspot to see the pass, RSVP, and your door status.';
  return 'Open in Bytspot to see the sale and ask the seller.';
}

export interface ShareCta {
  href: string;
  label: string;
  kind: 'primary' | 'secondary';
}

export function openInBytspotCta(shareUrl: string): ShareCta {
  return { href: shareUrl, label: 'Open in Bytspot', kind: 'primary' };
}

export function appStoreCta(): ShareCta {
  return { href: APP_STORE_URL, label: 'Get Bytspot on the App Store', kind: 'secondary' };
}

export interface SharePageOptions {
  documentTitle: string;
  description: string;
  ogTitle?: string;
  ogDescription?: string;
  shareUrl?: string;
  ogImage?: string | null;
  robotsNoIndex?: boolean;
  kicker?: string;
  heading: string;
  /** Already-escaped media markup (cover, photo). */
  mediaHtml?: string;
  /** Already-escaped body markup (chips, notes, host line). */
  bodyHtml: string;
  ctas?: ShareCta[];
  footnote?: string;
  /** Centered, shorter card for closed or error states. */
  shell?: boolean;
}

function mulberry32(seed: number) {
  let t = seed >>> 0;
  return () => {
    t += 0x6d2b79f5;
    let r = Math.imul(t ^ (t >>> 15), t | 1);
    r ^= r + Math.imul(r ^ (r >>> 7), r | 61);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

/** Deterministic starfield. Seed 72 matches the marketing site. */
function starfieldSvg(): string {
  const rand = mulberry32(72);
  const dots: string[] = [];
  for (let i = 0; i < 72; i += 1) {
    const cyan = i % 17 === 0;
    const x = (rand() * 100).toFixed(2);
    const y = (rand() * 100).toFixed(2);
    const r = (cyan ? 0.7 + rand() * 0.55 : 0.22 + rand() * 0.45).toFixed(2);
    const o = (cyan ? 0.55 + rand() * 0.35 : 0.22 + rand() * 0.5).toFixed(3);
    const dur = (3.2 + rand() * 5).toFixed(2);
    const delay = (rand() * 6).toFixed(2);
    const fill = cyan ? '#00BFFF' : '#F4EFE6';
    dots.push(
      `<circle class="star-twinkle" cx="${x}" cy="${y}" r="${r}" fill="${fill}" style="--star-o:${o};--star-dur:${dur}s;--star-delay:${delay}s;opacity:${o}"/>`,
    );
  }
  return `<div class="sky" aria-hidden="true"><svg viewBox="0 0 100 100" preserveAspectRatio="xMidYMid slice" focusable="false">${dots.join('')}</svg></div>`;
}

const STARFIELD = starfieldSvg();

/** Official Bytspot mark geometry (120-unit viewBox), without a backing tile. */
const BRAND_MARK = `<svg class="mark" width="32" height="32" viewBox="0 0 120 120" aria-hidden="true" focusable="false">
  <defs>
    <linearGradient id="bs-outer" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#00BFFF"/><stop offset="100%" stop-color="#00BFFF"/></linearGradient>
    <linearGradient id="bs-mid" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#A855F7"/><stop offset="100%" stop-color="#A855F7"/></linearGradient>
    <linearGradient id="bs-hex" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#A855F7"/><stop offset="100%" stop-color="#A855F7"/></linearGradient>
    <linearGradient id="bs-border" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#20A9FB"/><stop offset="100%" stop-color="#20A9FB"/></linearGradient>
    <radialGradient id="bs-dot" cx="50%" cy="50%" r="50%"><stop offset="0%" stop-color="#00BFFF"/><stop offset="100%" stop-color="#0099CC"/></radialGradient>
    <radialGradient id="bs-glow" cx="50%" cy="50%" r="50%"><stop offset="0%" stop-color="#00BFFF" stop-opacity="0.35"/><stop offset="100%" stop-color="#00BFFF" stop-opacity="0"/></radialGradient>
  </defs>
  <circle cx="60" cy="60" r="48" fill="none" stroke="url(#bs-outer)" stroke-width="3"/>
  <circle cx="60" cy="60" r="38" fill="none" stroke="url(#bs-mid)" stroke-width="2" opacity="0.4"/>
  <path d="M60 32 L74 41 L74 59 L60 68 L46 59 L46 41 Z" fill="url(#bs-hex)"/>
  <path d="M60 32 L74 41 L74 59 L60 68 L46 59 L46 41 Z" fill="none" stroke="url(#bs-border)" stroke-width="1.5"/>
  <circle cx="60" cy="50" r="12" fill="url(#bs-glow)"/>
  <circle cx="60" cy="50" r="8" fill="url(#bs-dot)"/>
</svg>`;

const SHARE_CSS = `:root{color-scheme:dark;--navy:#161B3A;--navy-deep:#0B1028;--navy-mid:#1C2348;--cyan:#00BFFF;--cyan-dim:rgba(0,191,255,.16);--bone:#F4EFE6;--bone-muted:#C8C0B3;--bone-soft:rgba(244,239,230,.78);--line:rgba(244,239,230,.14)}
*{box-sizing:border-box;margin:0;padding:0}
html,body{min-height:100%}
body{font:16px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;background:var(--navy-deep);color:var(--bone);min-height:100vh;display:flex;align-items:center;justify-content:center;padding:28px 20px 40px;-webkit-font-smoothing:antialiased}
.sky{position:fixed;inset:0;z-index:0;pointer-events:none;overflow:hidden;background:radial-gradient(ellipse at 50% -10%,rgba(0,191,255,.16) 0%,transparent 55%),#0B1028}
.sky svg{width:100%;height:100%;display:block}
@keyframes star-twinkle{0%,100%{opacity:var(--star-o,.7)}50%{opacity:calc(var(--star-o,.7)* .28)}}
.star-twinkle{animation:star-twinkle var(--star-dur,4s) ease-in-out infinite;animation-delay:var(--star-delay,0s)}
@media (prefers-reduced-motion:reduce){.star-twinkle{animation:none!important}}
main.card{position:relative;z-index:1;width:100%;max-width:28rem;background:rgba(22,27,58,.78);border:1px solid var(--line);border-radius:24px;padding:28px 24px 24px}
.brand{display:inline-flex;align-items:center;gap:10px;margin-bottom:22px;text-decoration:none;color:var(--bone);font-weight:650;letter-spacing:-.02em;font-size:1.05rem}
.brand .mark{display:block;flex:none}
.kicker{font-size:.8125rem;font-weight:650;color:var(--bone-muted)}
h1{font-size:1.75rem;font-weight:750;line-height:1.15;letter-spacing:-.03em;margin:6px 0 12px;color:var(--bone)}
.tagline{color:var(--bone-soft);font-weight:500;margin:0 0 12px}
.host,.venue{margin-top:12px;font-size:.9375rem;font-weight:650;color:var(--bone)}
.chips{display:flex;flex-wrap:wrap;gap:7px;margin:12px 0 4px}
.chip{background:rgba(0,191,255,.12);border:1px solid rgba(0,191,255,.22);color:var(--bone);border-radius:999px;padding:6px 12px;font-size:.75rem;font-weight:650;letter-spacing:.03em}
.note{margin-top:14px;font-size:.875rem;font-weight:500;color:var(--bone-muted)}
.price{font-size:1.125rem;font-weight:750;color:var(--cyan);margin:0 0 4px}
.cta{display:block;text-align:center;text-decoration:none;font-weight:700;font-size:1rem;padding:14px 16px;border-radius:999px;margin-top:12px}
.cta-primary{background:var(--cyan);color:var(--navy-deep)}
.cta-secondary{background:var(--bone);color:var(--navy-deep)}
.cta-primary:hover,.cta-secondary:hover{filter:brightness(1.06)}
.foot{margin-top:14px;font-size:.8125rem;font-weight:500;color:var(--bone-muted);text-align:center}
.cover,.photo{width:100%;object-fit:cover;border-radius:16px;display:block;margin:0 0 16px;background:var(--navy-mid)}
.cover{aspect-ratio:16/10}
.cover--empty{background:radial-gradient(ellipse at 50% 0%,rgba(0,191,255,.28),transparent 62%),var(--navy-mid)}
.photo{aspect-ratio:4/3}
.shell{text-align:center}
.shell h1{margin-top:4px}
.shell .note{margin-top:0}
:focus-visible{outline:2px solid var(--cyan);outline-offset:3px}
@media (min-width:800px){h1{font-size:2rem}main.card{padding:32px 28px}}`;

export function renderSharePage(options: SharePageOptions): string {
  const title = escapeHtml(options.documentTitle);
  const description = escapeHtml(options.description);
  const ogTitle = escapeHtml(options.ogTitle ?? options.documentTitle);
  const ogDescription = escapeHtml(options.ogDescription ?? options.description);
  const shareUrl = options.shareUrl ? escapeHtml(options.shareUrl) : '';
  const ogImage = options.ogImage ? escapeHtml(options.ogImage) : '';
  const kicker = options.kicker ? escapeHtml(options.kicker) : '';
  const heading = escapeHtml(options.heading);
  const footnote = options.footnote ? escapeHtml(options.footnote) : '';
  const twitterCard = ogImage ? 'summary_large_image' : 'summary';
  const ctas = (options.ctas ?? []).map((cta) => {
    const cls = cta.kind === 'primary' ? 'cta cta-primary' : 'cta cta-secondary';
    return `<a class="${cls}" href="${escapeHtml(cta.href)}">${escapeHtml(cta.label)}</a>`;
  }).join('');

  return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${title}</title>
<meta name="description" content="${description}">
<meta name="theme-color" content="#161B3A">
${options.robotsNoIndex ? '<meta name="robots" content="noindex">\n' : ''}<meta property="og:type" content="website">
<meta property="og:site_name" content="Bytspot">
<meta property="og:locale" content="en_US">
<meta property="og:title" content="${ogTitle}">
<meta property="og:description" content="${ogDescription}">
${shareUrl ? `<meta property="og:url" content="${shareUrl}">\n` : ''}${ogImage ? `<meta property="og:image" content="${ogImage}">\n` : ''}<meta name="twitter:card" content="${twitterCard}">
<meta name="twitter:title" content="${ogTitle}">
<meta name="twitter:description" content="${ogDescription}">
${ogImage ? `<meta name="twitter:image" content="${ogImage}">\n` : ''}${shareUrl ? `<meta name="apple-itunes-app" content="app-id=${APP_STORE_ID}, app-argument=${shareUrl}">\n` : ''}<style>
${SHARE_CSS}
</style>
</head><body>
${STARFIELD}
<main class="card${options.shell ? ' shell' : ''}">
<a class="brand" href="${MARKETING_URL}">${BRAND_MARK}<span>Bytspot</span></a>
${options.mediaHtml ?? ''}
${kicker ? `<p class="kicker">${kicker}</p>\n` : ''}<h1>${heading}</h1>
${options.bodyHtml}
${ctas}
${footnote ? `<p class="foot">${footnote}</p>` : ''}
</main>
</body></html>`;
}

export function renderShareShell(heading: string, body: string, extra?: { ctas?: ShareCta[] }): string {
  return renderSharePage({
    documentTitle: 'Bytspot',
    description: body,
    ogTitle: 'Bytspot',
    ogDescription: body,
    robotsNoIndex: true,
    heading,
    bodyHtml: `<p class="note">${escapeHtml(body)}</p>`,
    ctas: extra?.ctas,
    shell: true,
  });
}
