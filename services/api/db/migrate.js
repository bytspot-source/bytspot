import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getPool } from './db.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export async function migrate() {
  const pool = await getPool();
  await pool.query(`CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
  const applied = await pool.query(`SELECT id FROM schema_migrations`);
  const appliedSet = new Set(applied.rows.map(r => r.id));
  const dir = path.join(__dirname, 'migrations');
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort() : [];
  for (const f of files) {
    if (appliedSet.has(f)) continue;
    const sql = fs.readFileSync(path.join(dir, f), 'utf8');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations(id) VALUES ($1)', [f]);
      await client.query('COMMIT');
      console.log('Applied migration', f);
    } catch (e) {
      await client.query('ROLLBACK');
      console.error('Migration failed', f, e);
      throw e;
    } finally {
      client.release();
    }
  }
}

