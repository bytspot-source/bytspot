import { Router } from 'express';
import { getPool } from '../db/db.js';
import { EventEmitter } from 'node:events';

export const eventBus = new EventEmitter();
export const router = Router();

const ACTIVE_STATUSES = new Set(['pending', 'assigned', 'en_route', 'picked_up']);

function validateOrder(body) {
  const errs = [];
  if (body.pickup_lat == null || body.pickup_lng == null) errs.push('pickup_lat/lng required');
  if (typeof body.pickup_lat !== 'number' || typeof body.pickup_lng !== 'number') errs.push('pickup_lat/lng must be numbers');
  if (body.vehicle_make && typeof body.vehicle_make !== 'string') errs.push('vehicle_make must be string');
  if (errs.length) return errs.join('; ');
  return null;
}

// List orders with filtering
router.get('/orders', async (req, res) => {
  const { status } = req.query;
  const params = [];
  let where = '';
  if (status === 'active') {
    where = `WHERE status IN ('pending','assigned','en_route','picked_up')`;
  } else if (typeof status === 'string') {
    where = `WHERE status = $1`; params.push(status);
  }
  try {
    const db = await getPool();
    const result = await db.query(
      `SELECT id, user_id, status, pickup_lat, pickup_lng, created_at
       FROM valet_orders ${where}
       ORDER BY created_at DESC LIMIT 50`, params);
    return res.json(result.rows);
  } catch (err) {
    console.error('list orders failed', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

// Create order (with idempotency)
router.post('/orders', async (req, res) => {
  const {
    user_id = null,
    vehicle_make = null,
    vehicle_model = null,
    vehicle_color = null,
    license_plate = null,
    pickup_lat = null,
    pickup_lng = null,
    notes = null,
  } = req.body || {};

  const err = validateOrder(req.body || {});
  if (err) return res.status(400).json({ error: 'invalid_request', details: err });

  const idemKey = req.headers['idempotency-key'] || req.headers['Idempotency-Key'];

  const db = await getPool();
  const client = await db.connect();
  try {
    await client.query('BEGIN');

    if (idemKey) {
      const idem = await client.query('SELECT order_id FROM idempotency_keys WHERE key=$1', [idemKey]);
      if (idem.rowCount > 0) {
        const oid = idem.rows[0].order_id;
        const existing = await client.query('SELECT id, status FROM valet_orders WHERE id=$1', [oid]);
        await client.query('COMMIT');
        return res.status(200).json(existing.rows[0]);
      }
    }

    const result = await client.query(
      `INSERT INTO valet_orders (user_id, vehicle_make, vehicle_model, vehicle_color, license_plate, pickup_lat, pickup_lng, status, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'pending',$8)
       RETURNING id, status, created_at`,
      [user_id, vehicle_make, vehicle_model, vehicle_color, license_plate, pickup_lat, pickup_lng, notes]
    );
    const order = result.rows[0];

    if (idemKey) {
      await client.query('INSERT INTO idempotency_keys(key, order_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [idemKey, order.id]);
    }

    await client.query('COMMIT');
    eventBus.emit('order_event', { type: 'order_created', data: { id: order.id, status: order.status } });
    return res.status(201).json({ id: order.id, status: order.status });
  } catch (e) {
    console.error('create order failed', e);
    try { await client.query('ROLLBACK'); } catch {}
    return res.status(500).json({ error: 'internal_error' });
  } finally {
    client.release();
  }
});

// Get order
router.get('/orders/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const db = await getPool();
    const result = await db.query(
      `SELECT id, user_id, status, pickup_lat, pickup_lng, created_at FROM valet_orders WHERE id=$1`,
      [id]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: 'not_found' });
    return res.json(result.rows[0]);
  } catch (err) {
    console.error('get order failed', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

// Get order events
router.get('/orders/:id/events', async (req, res) => {
  const { id } = req.params;
  try {
    const db = await getPool();
    const result = await db.query(
      `SELECT id, type, payload, created_at FROM order_events WHERE order_id=$1 ORDER BY created_at DESC LIMIT 100`,
      [id]
    );
    return res.json(result.rows);
  } catch (err) {
    console.error('get order events failed', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

// Append order event (status change)
router.post('/orders/:id/events', async (req, res) => {
  const { id } = req.params;
  const { type, payload = {} } = req.body || {};
  const allowed = new Set(['assigned', 'en_route', 'picked_up', 'delivered', 'cancelled']);
  if (!allowed.has(type)) return res.status(400).json({ error: 'invalid_type' });
  if (payload !== null && typeof payload !== 'object') return res.status(400).json({ error: 'invalid_payload' });

  const db = await getPool();
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const order = await client.query('SELECT id FROM valet_orders WHERE id=$1 FOR UPDATE', [id]);
    if (order.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'not_found' });
    }
    await client.query(
      'INSERT INTO order_events (order_id, type, payload) VALUES ($1,$2,$3)',
      [id, type, payload]
    );
    await client.query('UPDATE valet_orders SET status=$1 WHERE id=$2', [type, id]);
    await client.query('COMMIT');

    eventBus.emit('order_event', { type: 'order_updated', data: { id: Number(id), status: type } });
    return res.status(202).json({ ok: true });
  } catch (err) {
    console.error('append event failed', err);
    try { await client.query('ROLLBACK'); } catch {}
    return res.status(500).json({ error: 'internal_error' });
  } finally {
    client.release();
  }
});

