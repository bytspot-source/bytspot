import { Router } from 'express';
import { z } from 'zod';
import { captureClientDiagnostic } from '../lib/observability';

const router = Router();

/**
 * Crash and hang reports from the iOS app.
 *
 * MetricKit hands the app a payload after the process that produced it is
 * already gone, so the report arrives on a later launch and cannot be tied to
 * a live session. It is accepted unauthenticated for the same reason: a crash
 * during sign-in is exactly the crash worth seeing, and refusing it would hide
 * the worst failures. Nothing here is trusted — the shape is fixed, the strings
 * are bounded, and unknown fields are dropped rather than forwarded.
 */
const diagnosticSchema = z.object({
  kind: z.enum(['crash', 'hang', 'diskWrite', 'cpuException']),
  // MetricKit's own identifiers, not the user's: no account, device, or
  // location value is accepted on this route.
  signal: z.string().max(64).optional(),
  terminationReason: z.string().max(512).optional(),
  exceptionType: z.string().max(64).optional(),
  appVersion: z.string().max(32).optional(),
  osVersion: z.string().max(64).optional(),
  callStackSummary: z.string().max(4000).optional(),
  occurredAt: z.string().max(40).optional(),
});

export type ClientDiagnostic = z.infer<typeof diagnosticSchema>;

const MAX_BATCH = 20;

router.post('/diagnostics/ios', (req, res) => {
  const parsed = z.object({ payloads: z.array(diagnosticSchema).max(MAX_BATCH) }).safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid diagnostic payload' });
    return;
  }

  for (const payload of parsed.data.payloads) {
    captureClientDiagnostic(payload);
  }

  // The app deletes its queue on success, so the count is its receipt.
  res.status(202).json({ accepted: parsed.data.payloads.length });
});

export default router;
