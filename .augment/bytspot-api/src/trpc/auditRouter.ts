import { z } from 'zod';
import { db } from '../lib/db';
import { publicProcedure, rateLimitMiddleware, router } from './trpc';

/**
 * Audit Sink — NIST PR.PT-1 (audit/log records).
 *
 * Receives batches of VirtualPatchAuditEvent from the client durable queue
 * (`src/utils/auditSink.ts` in bytspot-beta). Writes are append-only — there
 * is intentionally no update or delete surface here, so the audit trail is
 * tamper-evident at the application layer.
 *
 * The companion REST route `/audit/beacon` (see routes/audit.ts) accepts the
 * same payload via navigator.sendBeacon for page-hide flushes where tRPC
 * cannot run.
 */

const MAX_BATCH = 100;

export const auditEventSchema = z.object({
  at: z.string().datetime({ offset: true }),
  outcome: z.enum(['success', 'failure', 'revoked', 'consent_denied']),
  method: z.enum(['qr', 'nfc']),
  vendorId: z.string().max(120).nullable(),
  patchId: z.string().max(120).nullable(),
  uid: z.string().max(64).nullable(),
  tokenJti: z.string().max(120).nullable(),
  venueId: z.string().max(120).nullable(),
  reason: z.string().max(500).optional(),
});

export type AuditEventInput = z.infer<typeof auditEventSchema>;

/**
 * Append a batch of audit events. Returns the number persisted. Safe to call
 * with an empty array (returns 0). De-duplication is keyed on tokenJti when
 * present so retries from the client don't double-write success rows.
 */
export async function appendAuditEvents(events: AuditEventInput[]): Promise<number> {
  if (events.length === 0) return 0;

  const data = events.map((e) => ({
    at: new Date(e.at),
    outcome: e.outcome,
    method: e.method,
    vendorId: e.vendorId,
    patchId: e.patchId,
    uid: e.uid,
    tokenJti: e.tokenJti,
    venueId: e.venueId,
    reason: e.reason ?? null,
  }));

  const result = await db.auditLog.createMany({ data, skipDuplicates: true });
  return result.count;
}

export const auditRouter = router({
  /**
   * POST /trpc/audit.append — flush batch from the client durable queue.
   * Public + rate-limited because the sink runs from any client surface,
   * including unauthenticated app-clip launches.
   */
  append: publicProcedure
    .use(rateLimitMiddleware({ windowMs: 60_000, max: 60, label: 'audit:append' }))
    .input(
      z.object({
        events: z.array(auditEventSchema).min(1).max(MAX_BATCH),
      }),
    )
    .mutation(async ({ input }) => {
      const accepted = await appendAuditEvents(input.events);
      return { accepted };
    }),
});
