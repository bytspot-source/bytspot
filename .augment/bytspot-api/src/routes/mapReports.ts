import { Router, type Response } from 'express';
import { z } from 'zod';
import { db } from '../lib/db';
import { captureError } from '../lib/observability';
import {
  REPORT_SELECT,
  activeReportsNear,
  judgeRow,
  onMapReportChange,
  reportArea,
  reportHeadline,
  reportShareUrl,
  toPublicReport,
  withinRadius,
  type MapReportKind,
  type ReportRow,
} from '../services/mapReports';
import { APP_STORE_ID, APP_STORE_URL, escapeHtml } from './planLanding';
import { isInAppBrowserUA } from './partyLanding';

const router = Router();

const query = z.object({
  lat: z.coerce.number().min(-90).max(90),
  lng: z.coerce.number().min(-180).max(180),
  radiusMiles: z.coerce.number().min(0.1).max(5).default(1),
});

/** GET /map/reports/stream — SSE of Traffic Intel reports around a point.
 *  Starts with the active reports, then sends each new, changed or removed one. */
router.get('/map/reports/stream', async (req, res) => {
  const parsed = query.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: 'lat and lng are required' });
    return;
  }
  const center = { lat: parsed.data.lat, lng: parsed.data.lng };
  const { radiusMiles } = parsed.data;

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const unsubscribe = onMapReportChange((change) => {
    const point = change.type === 'upsert' ? change.report : change;
    if (!withinRadius(center, radiusMiles, point)) return;
    res.write(`data: ${JSON.stringify(change)}\n\n`);
  });

  try {
    const now = new Date();
    const rows = await activeReportsNear(center.lat, center.lng, radiusMiles, now);
    res.write(`data: ${JSON.stringify({ type: 'snapshot', reports: rows.map((row) => toPublicReport(row, judgeRow(row, now))) })}\n\n`);
  } catch { /* skip if DB down */ }

  const heartbeat = setInterval(() => { res.write(': ping\n\n'); }, 25_000);

  req.on('close', () => {
    clearInterval(heartbeat);
    unsubscribe();
  });
});

// Static markup only: no images, no scripts.
const ALERT_CSP = ["default-src 'none'", "style-src 'unsafe-inline'", "base-uri 'none'", "form-action 'none'", "frame-ancestors 'none'"].join(';');

const ALERT_STYLE = `:root{color-scheme:dark}
*{box-sizing:border-box;margin:0;padding:0}
body{background:#05070d;color:#fff;font:15px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
 min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px;text-align:left}
.card{width:100%;max-width:420px}
.brand{font-size:11px;font-weight:800;letter-spacing:.18em;color:#22d3a8;text-align:center;margin-bottom:18px}
.kicker{font-size:13px;font-weight:800;color:rgba(255,255,255,.62)}
h1{font-size:30px;font-weight:900;line-height:1.12;margin:6px 0 14px}
.chips{display:flex;flex-wrap:wrap;gap:7px}
.chip{background:rgba(255,255,255,.08);border-radius:999px;padding:7px 13px;font-size:11px;font-weight:800;letter-spacing:.04em}
.note{margin-top:16px;font-size:13px;font-weight:600;color:rgba(255,255,255,.55)}
.cta{display:block;margin-top:22px;background:#fff;color:#05070d;text-align:center;text-decoration:none;font-weight:900;font-size:16px;padding:16px;border-radius:16px}
.foot{margin-top:12px;font-size:12px;font-weight:600;color:rgba(255,255,255,.45);text-align:center}`;

export function minutesAgoLabel(createdAt: Date, now: Date): string {
  const minutes = Math.max(0, Math.floor((now.getTime() - createdAt.getTime()) / 60_000));
  return minutes === 0 ? 'Just now' : `${minutes} min ago`;
}

function sendAlertPage(res: Response, status: number, cache: string, html: string) {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', cache);
  res.setHeader('Content-Security-Policy', ALERT_CSP);
  return res.status(status).send(html);
}

function alertShell(heading: string, body: string): string {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>Bytspot</title><meta name="robots" content="noindex">
<style>${ALERT_STYLE}</style></head><body><div class="card"><div class="brand">BYTSPOT</div>
<h1>${heading}</h1><p class="note">${body}</p>
<a class="cta" href="${escapeHtml(APP_STORE_URL)}">Get Bytspot</a></div></body></html>`;
}

/**
 * GET /alert/:reportId — the page a shared Traffic Intel report opens, so
 * someone without the app sees it. Link previews read the HTML, so the alert
 * is in the response. It never names who reported or voted. A removed or
 * expired report reads as ended.
 */
router.get('/alert/:reportId', async (req, res) => {
  const reportId = req.params.reportId;
  const ended = () => sendAlertPage(res, 404, 'no-store', alertShell('This alert has ended', 'Map reports expire after 30 minutes, or sooner when people nearby say it\'s gone.'));
  if (reportId.length < 1 || reportId.length > 128) return ended();

  const now = new Date();
  let row: ReportRow | null;
  try {
    row = (await db.mapReport.findFirst({
      where: { id: reportId, removedAt: null, expiresAt: { gt: now }, reporter: { suspendedAt: null, deletedAt: null } },
      select: REPORT_SELECT,
    })) as ReportRow | null;
  } catch (error) {
    captureError(error, { route: 'map-report-alert' });
    return sendAlertPage(res, 500, 'no-store', alertShell("Bytspot can't load this right now", 'Please try again in a moment.'));
  }
  const verdict = row ? judgeRow(row, now) : null;
  if (!row || !verdict || verdict.removed || verdict.expiresAt <= now) return ended();

  const area = reportArea(row);
  const headline = escapeHtml(reportHeadline(row.kind as MapReportKind, row.venue?.name ?? null));
  const title = area ? `${escapeHtml(area)}: ${headline}` : headline;
  const status = verdict.confirmed ? 'Confirmed by members nearby' : 'Unconfirmed';
  const age = minutesAgoLabel(row.createdAt, now);
  const description = `${status} · ${age}. Live from the Bytspot Map.`;
  const shareUrl = escapeHtml(reportShareUrl(row.id));

  const html = `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${title} · Bytspot</title>
<meta name="description" content="${description}">
<meta property="og:type" content="website">
<meta property="og:title" content="${title}">
<meta property="og:description" content="${description}">
<meta property="og:url" content="${shareUrl}">
<meta name="twitter:card" content="summary">
<meta name="twitter:title" content="${title}">
<meta name="twitter:description" content="${description}">
<meta name="apple-itunes-app" content="app-id=${APP_STORE_ID}">
<style>${ALERT_STYLE}</style>
</head><body><div class="card">
<div class="brand">BYTSPOT</div>
<p class="kicker">${area ? escapeHtml(area) : 'Traffic Intel'}</p>
<h1>${headline}</h1>
<div class="chips"><span class="chip">${verdict.confirmed ? 'Confirmed' : 'Unconfirmed'}</span><span class="chip">${age}</span></div>
<p class="note">Reported by people on the Bytspot Map. A report is confirmed when others nearby agree, and expires after 30 minutes.</p>
<a class="cta" href="${escapeHtml(APP_STORE_URL)}">Get Bytspot</a>
${isInAppBrowserUA(req.get('user-agent'))
  ? `<p class="foot">This in-app browser can't open the App Store. Tap ⋯ and choose "Open in Safari".</p>`
  : `<p class="foot">See what's happening around you, live.</p>`}
</div></body></html>`;
  // Short-lived: a report changes and ends within minutes.
  res.setHeader('Vary', 'User-Agent');
  return sendAlertPage(res, 200, 'public, max-age=60', html);
});

export default router;
