import pg from 'pg';

let pool;
export async function getPool() {
  if (pool) return pool;
  const { DATABASE_URL } = process.env;
  if (!DATABASE_URL) throw new Error('DATABASE_URL not set');
  pool = new pg.Pool({ connectionString: DATABASE_URL, max: 10 });
  return pool;
}

