import { getPool } from './db.js';

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL not set');
    process.exit(1);
  }
  const db = await getPool();
  const u = await db.query("INSERT INTO users(email) VALUES ($1) ON CONFLICT (email) DO UPDATE SET email=EXCLUDED.email RETURNING id", ['seed@example.com']);
  const userId = u.rows[0].id;
  const o = await db.query(
    `INSERT INTO valet_orders(user_id, vehicle_make, pickup_lat, pickup_lng, status, notes)
     VALUES ($1,$2,$3,$4,'pending',$5)
     RETURNING id`,
    [userId, 'SeedCar', 33.7488, -84.3877, 'seed order']
  );
  console.log('Inserted order id', o.rows[0].id);
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });

