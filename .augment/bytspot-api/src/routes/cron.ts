import { timingSafeEqual } from 'crypto';
import { Router } from 'express';
import { config } from '../config';
import { db } from '../lib/db';
import { captureError } from '../lib/observability';
import { runCrowdAlerts } from '../services/crowdAlerts';
import { runCrowdSimulation } from '../services/crowdSimulator';
import { purgeExpiredAccounts } from '../services/accountDeletion';
import { purgeAbandonedPartyDrafts } from '../services/abandonedDrafts';

const router = Router();

/**
 * Verify the cron secret from a Bearer token.
 *
 * An unset secret must reject everything. Comparing against an empty expected
 * value used to accept a request with no Authorization header at all, which
 * left purge-accounts open to anyone whenever CRON_SECRET was missing.
 */
export function verifyCronSecret(req: { headers: Record<string, unknown> }): boolean {
  const expected = config.cronSecret;
  if (!expected) return false;

  const auth = typeof req.headers['authorization'] === 'string' ? (req.headers['authorization'] as string) : '';
  if (!auth.startsWith('Bearer ')) return false;

  const token = Buffer.from(auth.slice(7));
  const secret = Buffer.from(expected);
  if (token.length !== secret.length) return false;
  return timingSafeEqual(token, secret);
}

/**
 * POST /cron/crowd-alerts
 * Manual trigger / external cron endpoint.
 */
router.post('/cron/schema-diagnostic', async (req, res) => {
  if (!verifyCronSecret(req)) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  const names = ['party_sessions', 'party_tables', 'party_session_claims', 'party_checkouts', 'party_guests'];
  const tables = await db.$queryRawUnsafe<Array<{ name: string }>>(
    `SELECT c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname = ANY($1::text[]) ORDER BY 1`,
    names,
  );
  const columns = await db.$queryRawUnsafe<Array<{ table_name: string; column_name: string }>>(
    `SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = ANY($1::text[]) ORDER BY table_name, ordinal_position`,
    names,
  );
  const migrations = await db.$queryRawUnsafe<Array<{ migration_name: string; finished: boolean; rolled_back: boolean }>>(
    `SELECT migration_name, finished_at IS NOT NULL AS finished, rolled_back_at IS NOT NULL AS rolled_back FROM _prisma_migrations WHERE migration_name ILIKE '%party%' OR migration_name ILIKE '%session%' OR migration_name ILIKE '%table%' ORDER BY started_at`,
  );
  res.json({ tables, columns, migrations });
});

router.post('/cron/crowd-alerts', async (req, res) => {
  if (!verifyCronSecret(req)) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  try {
    const result = await runCrowdAlerts();
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error('[cron/crowd-alerts] error:', err);
    captureError(err, { job: 'crowd-alerts' });
    res.status(500).json({ error: 'Internal error' });
  }
});

/**
 * POST /cron/crowd-sim
 * Trigger crowd simulation manually (generates fresh crowd data for all venues).
 */
router.post('/cron/crowd-sim', async (req, res) => {
  if (!verifyCronSecret(req)) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  try {
    const result = await runCrowdSimulation();
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error('[cron/crowd-sim] error:', err);
    captureError(err, { job: 'crowd-sim' });
    res.status(500).json({ error: 'Internal error' });
  }
});

/**
 * POST /cron/purge-accounts
 * Irreversibly removes accounts whose deletion grace period has elapsed.
 */
router.post('/cron/purge-accounts', async (req, res) => {
  if (!verifyCronSecret(req)) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  try {
    const result = await purgeExpiredAccounts();
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error('[cron/purge-accounts] error:', err);
    captureError(err, { job: 'purge-accounts' });
    res.status(500).json({ error: 'Internal error' });
  }
});

/**
 * POST /cron/purge-party-drafts
 * Removes Host Studio drafts left untouched past their TTL. Published
 * parties are never eligible.
 */
router.post('/cron/purge-party-drafts', async (req, res) => {
  if (!verifyCronSecret(req)) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  try {
    const result = await purgeAbandonedPartyDrafts();
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error('[cron/purge-party-drafts] error:', err);
    captureError(err, { job: 'purge-party-drafts' });
    res.status(500).json({ error: 'Internal error' });
  }
});

export default router;

