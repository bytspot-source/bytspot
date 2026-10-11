import { Router } from 'express';
import { z } from 'zod';
import { activeReportsNear, judgeRow, onMapReportChange, toPublicReport, withinRadius } from '../services/mapReports';

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

export default router;
