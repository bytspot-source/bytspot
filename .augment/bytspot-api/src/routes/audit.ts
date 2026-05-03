import { Router } from 'express';
import { appendAuditEvents, auditEventSchema } from '../trpc/auditRouter';
import { z } from 'zod';

/**
 * /audit/beacon — sendBeacon fallback for the client durable audit queue.
 *
 * navigator.sendBeacon cannot ride the tRPC channel (no fetch/abort hooks,
 * fixed Content-Type rules), so the client posts a raw JSON envelope here
 * on page-hide. The handler shares its zod schema and persistence helper
 * with `audit.append` so the two paths are guaranteed to round-trip the
 * same shape into the same `audit_logs` table.
 */
const router = Router();

const beaconSchema = z.object({
  events: z.array(auditEventSchema).min(1).max(100),
});

router.post('/audit/beacon', async (req, res) => {
  const parsed = beaconSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid audit payload' });
    return;
  }

  try {
    const accepted = await appendAuditEvents(parsed.data.events);
    // sendBeacon ignores the body, but a 204 keeps logs clean for the rare
    // case the call was issued from a non-beacon client (manual curl, tests).
    res.status(204).json({ accepted });
  } catch (err: any) {
    console.error('[audit/beacon] persist failed:', err?.message);
    res.status(500).json({ error: 'Failed to persist audit events' });
  }
});

export default router;
