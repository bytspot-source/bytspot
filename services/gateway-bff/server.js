import Fastify from 'fastify';
import cors from '@fastify/cors';
import proxy from '@fastify/http-proxy';
import jwt from 'jsonwebtoken';
import Stripe from 'stripe';
import { Server as IOServer } from 'socket.io';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OPENAPI_DIR = path.join(__dirname, 'openapi');
function redocHtml(title, specUrl) {
  return `<!DOCTYPE html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>${title}</title>
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <style>body{margin:0;padding:0;} .redoc-wrap{height:100vh;}</style>
  </head>
  <body>
    <div class="redoc-wrap"></div>
    <script src="https://cdn.jsdelivr.net/npm/redoc@next/bundles/redoc.standalone.js"></script>
    <script>Redoc.init('${specUrl}', {}, document.querySelector('.redoc-wrap'))</script>
  </body>
</html>`;
}

function swaggerHtml(title, specUrl) {
  return `<!DOCTYPE html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>${title}</title>
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5/swagger-ui.css" />
  </head>
  <body>
    <div id="swagger-ui"></div>
    <script src="https://unpkg.com/swagger-ui-dist@5/swagger-ui-bundle.js"></script>
    <script>
      window.ui = SwaggerUIBundle({ url: '${specUrl}', dom_id: '#swagger-ui' });
    </script>
  </body>
</html>`;
}

function docsIndexHtml() {
  return `<!DOCTYPE html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>API Docs</title>
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <style>body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;padding:24px;line-height:1.5} a{display:block;margin:6px 0}</style>
  </head>
  <body>
    <h1>API Docs</h1>
    <h2>Redoc</h2>
    <a href="/docs/bff-valet">/docs/bff-valet</a>
    <a href="/docs/upstream-valet">/docs/upstream-valet</a>
    <h2>Swagger UI</h2>
    <a href="/swagger/bff-valet">/swagger/bff-valet</a>
    <a href="/swagger/upstream-valet">/swagger/upstream-valet</a>
  </body>
</html>`;
}



const app = Fastify({ logger: true });

const CORS_ORIGIN = process.env.CORS_ORIGIN;
app.register(cors, { origin: CORS_ORIGIN ? CORS_ORIGIN.split(',') : true, credentials: true });

// Content-type parser to allow raw body for Stripe webhook while keeping JSON for others
app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (req, body, done) => {
  try {
    if (req.url === '/api/payments/webhook') {
      // Keep raw buffer for Stripe signature verification
      return done(null, body);
    }
    const json = JSON.parse(body.toString('utf8'));
    return done(null, json);
  } catch (err) {
    return done(err, undefined);
  }
});

// Socket.IO (beta)
const io = new IOServer(app.server, { cors: { origin: CORS_ORIGIN ? CORS_ORIGIN.split(',') : true } });
io.on('connection', (socket) => {
  app.log.info({ id: socket.id }, 'socket connected');
  socket.emit('hello', { ok: true });
  // Insider realtime vibes subscription
  socket.on('subscribe:insider', (payload) => {
    const interests = Array.isArray(payload?.interests) ? payload.interests : [];
    const lifestyles = Array.isArray(payload?.lifestyles) ? payload.lifestyles : [];
    socket.join('insider:all');
    interests.forEach(i => socket.join(`insider:interest:${i}`));
    lifestyles.forEach(l => socket.join(`insider:lifestyle:${l}`));
    socket.emit('insider:subscribed', { rooms: Array.from(socket.rooms) });
  });
  socket.on('disconnect', () => app.log.info({ id: socket.id }, 'socket disconnected'));
});

// Dev ticker for vibe updates (mock)
if (!globalThis.__vibeTicker) {
  globalThis.__vibeTicker = setInterval(() => {
    try {
      const venues = (globalThis.adminVenues || []);
      const sample = (Array.isArray(venues) && venues.length ? venues : [
        { id: 'v1', title: 'Energetic Bar' }, { id: 'v2', title: 'Chill Lounge' }
      ]);
      const base = { lat: 37.7749, lng: -122.4194 }; // dev center fallback
      sample.forEach((v) => {
        const score = Math.round((Math.random()*5 + 3) * 10) / 10; // 3.0 - 8.0
        const coord = venueCoords.get(v.id);
        const lat = coord?.lat ?? (base.lat + (Math.random()-0.5) * 0.02);
        const lng = coord?.lng ?? (base.lng + (Math.random()-0.5) * 0.02);
        const payload = { venueId: v.id, type: 'venue', score, ts: Date.now(), lat, lng, title: v.title };
        io.to('insider:all').emit('vibe:update', payload);
        io.to('insider:interest:venue').emit('vibe:update', payload);
        io.to('insider:interest:dining').emit('vibe:update', payload);
      });
    } catch {}
  }, 5000);
}

const AUTH_SERVICE_URL = process.env.AUTH_SERVICE_URL || 'http://localhost:8090';
const VENUE_SERVICE_URL = process.env.VENUE_SERVICE_URL || 'http://localhost:8092';
const PARKING_SERVICE_URL = process.env.PARKING_SERVICE_URL || 'http://localhost:8094';
const VALET_SERVICE_URL = process.env.VALET_SERVICE_URL || 'http://localhost:8096';
const JWT_SECRET = process.env.JWT_SECRET || 'dev_secret_change_me';
const ADMIN_REQUIRE_AUTH = process.env.ADMIN_REQUIRE_AUTH !== 'false'; // default true

// Stripe (MVP)
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || '';
const stripe = STRIPE_SECRET_KEY ? new Stripe(STRIPE_SECRET_KEY, { apiVersion: '2024-06-20' }) : null;

app.get('/healthz', async () => ({ status: 'ok' }));

function requireJWT(req, reply) {
  const auth = req.headers['authorization'];
  if (!auth || !auth.startsWith('Bearer ')) {
    reply.code(401).send({ error: 'missing token' });
    return null;
  }
  const token = auth.substring('Bearer '.length);
  try {
    return jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] });
  } catch (e) {
    reply.code(401).send({ error: 'invalid token' });
    return null;
  }
}

function requireAdmin(req, reply) {
  const decoded = requireJWT(req, reply);
  if (!decoded) return null;
  const roles = decoded.roles || [];
  if (!Array.isArray(roles) || !roles.includes('admin')) {
    reply.code(403).send({ error: 'admin role required' });
    return null;
  }
  return decoded;
}

// Minimal in-memory rate limiter, correlation id, and basic body/content checks
const rateBuckets = new Map(); // key: ip|bucket -> { count, reset }
const metrics = { requests: 0, rateLimited: 0 };
const RATE_CFG = [
  { prefix: '/api/venues/', method: 'POST', limit: Number(process.env.RATE_VENUE_POST_LIMIT||30), windowMs: Number(process.env.RATE_WINDOW_MS||60000) },
  { prefix: '/api/auth/phone/start', method: 'POST', limit: Number(process.env.RATE_PHONE_START_LIMIT||3), windowMs: Number(process.env.RATE_PHONE_WINDOW_MS||60000) },
  { prefix: '/api/auth/phone/verify', method: 'POST', limit: Number(process.env.RATE_PHONE_VERIFY_LIMIT||6), windowMs: Number(process.env.RATE_PHONE_WINDOW_MS||60000) },
  { prefix: '/api/contacts/match', method: 'POST', limit: Number(process.env.RATE_CONTACTS_MATCH_LIMIT||5), windowMs: Number(process.env.RATE_CONTACTS_WINDOW_MS||60000) },
];
// Idempotency store for Stripe events (in-memory with TTL)
let seenStripeEvents = new Map(); // id -> ts
const STRIPE_EVENT_TTL_MS = 24 * 60 * 60 * 1000; // 24h
function recordEventOnce(eid) {
  if (!eid) return false;
  const now = Date.now();
  if (seenStripeEvents.has(eid)) return false;
  seenStripeEvents.set(eid, now);
  return true;
}
function gcStripeEvents() {
  const now = Date.now();
  for (const [k, ts] of seenStripeEvents.entries()) {
    if (now - ts > STRIPE_EVENT_TTL_MS) seenStripeEvents.delete(k);
  }
}
if (!globalThis.__stripeIdemGc) {
  globalThis.__stripeIdemGc = setInterval(gcStripeEvents, 10 * 60 * 1000);
}

app.addHook('onRequest', async (req, reply) => {
  try {
    // correlation id
    const corr = req.headers['x-correlation-id'] || req.id;
    if (corr) reply.header('x-correlation-id', String(corr));
    // path/method checks
    const url = req.url || '';
    const method = (req.method || 'GET').toUpperCase();
    // Admin/auth gating (path-based since proxy may not set routerPath)
    if (url.startsWith('/api/secure')) {
      if (!requireJWT(req, reply)) return;
    }
    if (ADMIN_REQUIRE_AUTH && url.startsWith('/api/admin')) {
      if (!requireAdmin(req, reply)) return;
    }
    // Basic rate limit and content checks
    const cfg = RATE_CFG.find(c => method === c.method && url.startsWith(c.prefix));
    if (cfg) {
      const ip = req.ip || req.socket?.remoteAddress || 'unknown';
      const key = `${ip}|${cfg.prefix}`;
      const now = Date.now();
      let b = rateBuckets.get(key);
      if (!b || b.reset < now) { b = { count: 0, reset: now + cfg.windowMs }; rateBuckets.set(key, b); }
      b.count += 1;
      if (b.count > cfg.limit) {
        metrics.rateLimited++;

        reply.code(429).send({ error: 'rate limit exceeded' });
        return;
      }
      // Enforce JSON and small bodies for write endpoints
      const ct = req.headers['content-type'] || '';
      if (!ct.includes('application/json')) {
        reply.code(415).send({ error: 'content-type must be application/json' });
        return;
      }
      const cl = Number(req.headers['content-length'] || 0);
      const max = Number(process.env.BODY_MAX_BYTES || 10_000);
      if (cl > max) {
        reply.code(413).send({ error: 'payload too large' });
        return;
      }
    }
  } catch (e) {
    req.log.error(e);
  }
});
app.addHook('onResponse', async (req, reply) => { metrics.requests++; });

app.get('/metrics', async (req, reply) => {
  reply.header('Content-Type', 'text/plain; version=0.0.4');
  reply.send(`bff_requests_total ${metrics.requests}\n` + `bff_rate_limited_total ${metrics.rateLimited}\n`);
});

// In-memory admin data (beta mock)
let adminVenues = [
  { id: 'v1', title: 'Energetic Bar', subtitle: 'Downtown', rating: 4.5, distance: '0.5km', price: '$$' },
  { id: 'v2', title: 'Chill Lounge', subtitle: 'Riverside', rating: 4.2, distance: '1.2km', price: '$' },
];
// Periodically refresh venue coordinates from venue service (best-effort)
let venueCoords = new Map(); // id -> { lat, lng }
async function refreshVenueCoords() {
  try {
    const r = await fetch(`${VENUE_SERVICE_URL}/venues/discover`);
    if (!r.ok) return;
    const d = await r.json().catch(()=>({ items: [] }));
    const items = Array.isArray(d.items) ? d.items : [];
    const next = new Map();
    for (const v of items) {
      const lat = v.lat ?? v?.location?.lat ?? v?.geo?.lat ?? v?.data?.lat;
      const lng = v.lng ?? v?.location?.lng ?? v?.geo?.lng ?? v?.data?.lng;
      if (typeof lat === 'number' && typeof lng === 'number') next.set(v.id, { lat, lng });
    }
    if (next.size) venueCoords = next;
  } catch (e) { app.log.warn('refreshVenueCoords failed'); }
}
if (!globalThis.__venueCoordsTicker) {
  globalThis.__venueCoordsTicker = setInterval(refreshVenueCoords, 30_000);
  refreshVenueCoords();
}

let adminUsers = [
  { id: 'u1', email: 'demo@bytspot.ai', name: 'Demo User', roles: ['admin'] },
];

// Body validation for selected endpoints
app.addHook('preValidation', async (req, reply) => {
  const url = req.url || '';
  const method = (req.method || 'GET').toUpperCase();
  try {
    if (method === 'POST' && (url === '/api/auth/login' || url === '/api/auth/register')) {
      const b = req.body || {};
      const ok = b && typeof b.email === 'string' && b.email.length <= 256 && typeof b.password === 'string' && b.password.length <= 256;
      if (!ok) return reply.code(400).send({ error: 'invalid credentials payload' });
    }
    if (method === 'POST' && (url === '/api/auth/phone/start' || url === '/api/auth/phone/verify')) {
      const b = req.body || {};
      if (url.endsWith('/start')) {
        const ok = b && typeof b.phone === 'string' && b.phone.length >= 8 && b.phone.length <= 20;
        if (!ok) return reply.code(400).send({ error: 'invalid phone' });
      } else {
        const ok = b && typeof b.phone === 'string' && typeof b.code === 'string' && b.code.length === 6;
        if (!ok) return reply.code(400).send({ error: 'invalid payload' });
      }
    }
    if (method === 'POST' && url.endsWith('/vibe') && url.startsWith('/api/venues/')) {
      const b = req.body || {};
      const ok = b && typeof b.vibeScore === 'number' && b.vibeScore >= 0 && b.vibeScore <= 10;
      if (!ok) return reply.code(400).send({ error: 'invalid vibe payload' });
    }
    if (method === 'POST' && url === '/api/admin/venues') {
      const b = req.body || {};
      if (!b || typeof b.title !== 'string' || !b.title.trim()) return reply.code(400).send({ error: 'title required' });
    }
  } catch (e) {
    req.log.error(e);
    reply.code(400).send({ error: 'invalid payload' });
  }
  if (method === 'POST' && url === '/api/contacts/match') {
    const b = req.body || {};
    const ok = b && Array.isArray(b.hashes) && b.hashes.length > 0 && b.hashes.every((h)=> typeof h === 'string' && h.length >= 32 && h.length <= 128);
    if (!ok) return reply.code(400).send({ error: 'invalid payload' });
  }
  if (method === 'POST' && url === '/api/valet/intake') {
    const b = req.body || {};
    const ok = b && typeof b.userId === 'string' && b.userId && typeof b.vehicle === 'object' && b.vehicle && typeof b.vehicle.make === 'string' && typeof b.vehicle.model === 'string';
    if (!ok) return reply.code(400).send({ error: 'invalid intake payload' });
    if (Array.isArray(b.services)) {
      const allowed = new Set(['basic_wash','full_detail','ev_charging']);
      const bad = b.services.some((s)=> typeof s !== 'string' || !allowed.has(s));
      if (bad) return reply.code(400).send({ error: 'invalid service' });
    }
    if (Array.isArray(b.photos) && b.photos.length > 10) return reply.code(400).send({ error: 'too many photos' });
  }
  if (method === 'PATCH' && url.startsWith('/api/valet/vehicles/') && url.endsWith('/status')) {
    const b = req.body || {};
    const allowed = new Set(['intake','parked','service_in_progress','ready','retrieved']);
    if (!b || typeof b.status !== 'string' || !allowed.has(b.status)) return reply.code(400).send({ error: 'invalid status' });
  }


});

app.get('/api/admin/venues', async () => ({ items: adminVenues }));
app.post('/api/admin/venues', async (req, reply) => {
  const body = req.body || {};
  const id = 'v' + (adminVenues.length + 1);
  const venue = { id, title: body.title, subtitle: body.subtitle || '', rating: body.rating || 0, distance: body.distance || '0km', price: body.price || '$' };
  adminVenues.push(venue);
  reply.code(201).send(venue);
});
app.get('/api/admin/users', async () => ({ items: adminUsers }));
app.get('/api/admin/analytics/summary', async () => ({ users: adminUsers.length, venues: adminVenues.length, likes: 0 }));

// Helper: role-aware session for gating UI
app.get('/api/auth/session', async (req, reply) => {
  const decoded = requireJWT(req, reply);
  if (!decoded) return; // response already sent
  reply.send({ sub: decoded.sub, roles: decoded.roles || [] });
});

// Device tokens (dev/in-memory)
const deviceTokens = { user: new Set(), driver: new Set() };
app.post('/api/devices/register', async (req, reply) => {
  const b = req.body || {};
  const role = b.role === 'driver' ? 'driver' : 'user';
  if (!b || typeof b.token !== 'string') return reply.code(400).send({ error: 'invalid device payload' });
  deviceTokens[role].add(b.token);
  reply.send({ status: 'ok' });
});

// Simple presence endpoint for pre-arrival
app.post('/api/presence', async (req, reply) => {
  const b = req.body || {};
  const ok = b && typeof b.userId === 'string' && typeof b.venueId === 'string' && typeof b.ttlSec === 'number';
  if (!ok) return reply.code(400).send({ error: 'invalid presence payload' });
  const now = Date.now();
  const expiry = now + Math.min(Math.max(b.ttlSec, 60), 600) * 1000;
  if (!globalThis.__presence) globalThis.__presence = new Map();
  globalThis.__presence.set(`${b.venueId}|${b.userId}`, expiry);
  try { io.emit('presence:venue', { venueId: b.venueId, userId: b.userId, expiresAt: expiry }); } catch {}
  reply.send({ status: 'ok', expiresAt: expiry });
});

// Dev push sender (Expo push)
app.post('/api/notify/valet', async (req, reply) => {
  const b = req.body || {};
  if (!b || typeof b.to !== 'string' || typeof b.title !== 'string' || typeof b.body !== 'string') return reply.code(400).send({ error: 'invalid notify payload' });
  try {
    const r = await fetch('https://exp.host/--/api/v2/push/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ to: b.to, title: b.title, body: b.body })
    });
    const d = await r.json().catch(() => ({}));
    reply.send({ status: 'queued', result: d });
  } catch (e) {
    req.log.error(e);
    reply.code(500).send({ error: 'push failed' });
  }
});

// Stripe checkout session (MVP)
app.post('/api/payments/checkout-session', async (req, reply) => {
  try {
    if (!stripe) return reply.code(500).send({ error: 'stripe not configured' });
    const b = req.body || {};
    const items = Array.isArray(b.items) ? b.items : [];
    const line_items = items.map((it) => ({
      price_data: {
        currency: it.currency || 'usd',
        product_data: { name: it.name || 'Valet Service' },
        unit_amount: Number(it.amount) || 1000,
      },
      quantity: Number(it.quantity) || 1,
    }));
    const success_url = b.successUrl || process.env.CHECKOUT_SUCCESS_URL || 'https://example.com/success';
    const cancel_url = b.cancelUrl || process.env.CHECKOUT_CANCEL_URL || 'https://example.com/cancel';
    const mode = b.mode || 'payment';
    const metadata = Object.assign({}, b.metadata || {}, b.ticketId ? { ticketId: String(b.ticketId) } : {}, b.userId ? { userId: String(b.userId) } : {});
    const session = await stripe.checkout.sessions.create({ mode, line_items, success_url, cancel_url, metadata });
    reply.send({ id: session.id, url: session.url });
  } catch (e) {
    req.log.error(e);
    reply.code(500).send({ error: 'stripe error' });
  }
});

// Retrieve Checkout Session details for enrichment (safe, read-only)
app.get('/api/payments/session', async (req, reply) => {
  try {
    const id = String(req.query?.id || '').trim();
    if (!id) return reply.code(400).send({ error: 'id required' });
    if (!stripe) return reply.code(500).send({ error: 'stripe not configured' });

    // Expand payment_intent to infer method details when available
    const session = await stripe.checkout.sessions.retrieve(id, { expand: ['payment_intent'] });
    const pi = typeof session.payment_intent === 'object' ? session.payment_intent : null;

    let payment_method = undefined;
    let payment_method_types = undefined;
    try {
      // Prefer charge-level method details if present
      const charge = Array.isArray(pi?.charges?.data) ? pi.charges.data[0] : null;
      const pmd = charge?.payment_method_details;
      if (pmd?.type === 'card') payment_method = pmd.card?.brand ? `card_${pmd.card.brand}` : 'card';
      else if (typeof pmd?.type === 'string') payment_method = pmd.type;
    } catch {}

    payment_method_types = (pi?.payment_method_types && Array.isArray(pi.payment_method_types))
      ? pi.payment_method_types
      : (Array.isArray(session.payment_method_types) ? session.payment_method_types : undefined);

    reply.send({
      id: session.id,
      amount_total: session.amount_total,
      currency: session.currency,
      payment_status: session.payment_status,
      mode: session.mode,
      payment_method,
      payment_method_types,
    });
  } catch (e) {
    req.log?.error(e);
    reply.code(500).send({ error: 'stripe session lookup failed' });
  }
});


// Stripe webhook (signature-verified when secret provided)
app.post('/api/payments/webhook', async (req, reply) => {
  try {
    let event = null;
    const sig = req.headers['stripe-signature'];
    const secret = process.env.STRIPE_WEBHOOK_SECRET;
    if (sig && secret && stripe) {
      try {
        // req.body is Buffer due to custom content-type parser
        event = stripe.webhooks.constructEvent(req.body, sig, secret);
      } catch (err) {
        req.log.error({ err: err?.message }, 'stripe signature verification failed');
        return reply.code(400).send({ error: 'invalid signature' });
      }
    } else {
      // Dev fallback: parse as JSON
      try { event = JSON.parse(Buffer.isBuffer(req.body) ? req.body.toString('utf8') : String(req.body)); } catch { event = req.body; }
    }

    const eid = event?.id;
    if (eid && !recordEventOnce(eid)) {
      // Duplicate delivery; acknowledge but do nothing
      return reply.send({ received: true, duplicate: true });
    }

    const obj = event?.data?.object || {};
    app.log.info({ type: event?.type, id: obj.id }, 'stripe webhook');

    if (event?.type === 'checkout.session.completed') {
      const md = obj.metadata || {};
      app.log.info({ metadata: md }, 'payment completed');
      // Persist: mark ticket paid in valet service, then broadcast to clients
      try {
        if (md.ticketId) await markTicketPaid(md.ticketId);
      } catch (e) { req.log.error(e); }
      try {
        if (md.ticketId) io.emit('valet:task', { id: String(md.ticketId), status: 'paid', paidAt: Date.now() });
      } catch {}
    }

    reply.send({ received: true });
  } catch (e) {
    req.log.error(e);
    reply.code(400).send({ error: 'webhook error' });
  }
});

// Mark ticket paid in valet service (helper)
async function markTicketPaid(ticketId) {
  if (!ticketId) return false;
  try {
    const r = await fetch(`${VALET_SERVICE_URL}/valet/tickets/${encodeURIComponent(ticketId)}/paid`, { method: 'POST' });
    return r.ok;
  } catch (e) {
    app.log.error(e);
    return false;
  }
}

// Valet wrappers: forward to valet service and emit socket updates
app.post('/api/valet/intake', async (req, reply) => {
  try {
    const b = typeof req.body === 'object' ? req.body : JSON.parse(Buffer.isBuffer(req.body) ? req.body.toString('utf8') : String(req.body));
    const r = await fetch(`${VALET_SERVICE_URL}/valet/intake`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b)
    });
    const d = await r.json().catch(()=>({}));
    try { io.emit('valet:task', { id: d.ticket || d.id, status: 'intake', ...d }); } catch {}
    reply.code(r.status).send(d);
  } catch (e) {
    req.log.error(e);
    reply.code(500).send({ error: 'intake failed' });
  }
});

app.patch('/api/valet/vehicles/:id/status', async (req, reply) => {
  try {
    const id = req.params?.id;
    const b = typeof req.body === 'object' ? req.body : JSON.parse(Buffer.isBuffer(req.body) ? req.body.toString('utf8') : String(req.body));
    const r = await fetch(`${VALET_SERVICE_URL}/valet/vehicles/${encodeURIComponent(id)}/status`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b)
    });
    const d = await r.json().catch(()=>({ id, ...b }));
    try { io.emit('valet:task', { id: d.id || id, status: d.status || b.status, ...d }); } catch {}
    reply.code(r.status).send(d);
  } catch (e) {
    req.log.error(e);
    reply.code(500).send({ error: 'status update failed' });
  }
});


// Host Onboarding helper (skeleton)
app.get('/api/host/onboarding/types', async () => ({
  progress: 20,
  types: [
    { key: 'venue', label: 'Venue Hosting', description: 'Restaurants, bars, event spaces, and entertainment venues' },
    { key: 'parking', label: 'Parking Management', description: 'Parking lots, garages, and private parking spaces' },
    { key: 'valet', label: 'Valet Service', description: 'Professional valet and concierge services for hosts' }
  ]
}));

// Discovery aggregator: venues + parking + valet offers
app.get('/api/discover/cards', async (req, reply) => {
  try {
    const interests = String((req.query || {}).interests || '').split(',').filter(Boolean);
    const [vr, pr] = await Promise.all([
      fetch(`${VENUE_SERVICE_URL}/venues/discover`),
      fetch(`${PARKING_SERVICE_URL}/parking/search`)
    ]);
    const vd = vr.ok ? await vr.json() : { items: [] };
    const pd = pr.ok ? await pr.json() : { items: [] };
    const venueCards = (vd.items || []).map((v) => ({
      id: v.id, type: 'venue', title: v.title, subtitle: v.subtitle, rating: v.rating, distance: v.distance, price: v.price, data: v,
    }));
    const parkingCards = (pd.items || []).map((p) => ({
      id: `p:${p.id}`, type: 'parking', title: p.name, subtitle: p.distance, tags: p.features, data: p,
    }));
    const valetOffers = [{ id: 'valet-offer-1', type: 'valet', title: 'Valet Available', subtitle: 'Request drop-off & services', data: { offer: true } }];
    let cards = [...venueCards, ...parkingCards, ...valetOffers];
    if (interests.length) {
      const weight = (c) => {
        let w = 1;
        if (c.type === 'venue' && interests.includes('dining')) w += 2;
        if (interests.includes(c.type)) w += 3;
        return w;
      };
      // Weighted shuffle (repeat by weight then shuffle)
      const expanded = [];
      for (const c of cards) { const w = weight(c); for (let i=0;i<w;i++) expanded.push(c); }
      for (let i = expanded.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [expanded[i], expanded[j]] = [expanded[j], expanded[i]]; }
      // De-dup keeping first appearances
      const seen = new Set(); const result = [];
      for (const c of expanded) { if (!seen.has(c.id)) { seen.add(c.id); result.push(c); } }
      cards = result;
    }
    reply.send({ items: cards });
  } catch (e) {
    req.log.error(e);
    reply.code(500).send({ error: 'aggregator error' });
  }
});

// Optional: debugging endpoint to log onboarding state via BFF
app.get('/api/host/onboarding/log', async (req, reply) => {
  const auth = req.headers['authorization'];
  if (!auth) return reply.code(401).send({ error: 'missing token' });
  try {


    const r = await fetch(`${AUTH_SERVICE_URL}/host/onboarding`, { headers: { authorization: auth } });
    const d = r.ok ? await r.json() : null;
    app.log.info({ onboarding: d }, 'Onboarding state');
    reply.send(d || {});
  } catch (e) {
    app.log.error(e);
    reply.code(500).send({ error: 'upstream error' });
  }
});

// Contacts match proxy to auth-service
app.post('/api/contacts/match', async (req, reply) => {
  try {
    const r = await fetch(`${AUTH_SERVICE_URL}/contacts/match`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req.body || { hashes: [] })
    });
    const d = await r.json();
    reply.code(r.status).send(d);
  } catch (e) {
    app.log.error(e);
    reply.code(500).send({ error: 'upstream error' });
  }
});

// Swagger UI pages
app.get('/swagger/bff-valet', async (_req, reply) => {
  reply.type('text/html').send(swaggerHtml('BFF Valet API', '/openapi/bff-valet.yaml'));
});
app.get('/swagger/upstream-valet', async (_req, reply) => {
  reply.type('text/html').send(swaggerHtml('Upstream Valet API', '/openapi/upstream-valet.yaml'));
});

// OpenAPI YAML serving
app.get('/openapi/bff-valet.yaml', async (_req, reply) => {
  try {
    const p = path.join(OPENAPI_DIR, 'bff-valet.yaml');
    const y = fs.readFileSync(p, 'utf8');
    reply.type('text/yaml').send(y);
  } catch (e) {
    app.log.error(e);
    reply.code(404).send('not found');
  }
});
app.get('/openapi/upstream-valet.yaml', async (_req, reply) => {
  try {
    const p = path.join(OPENAPI_DIR, 'upstream-valet.yaml');
    const y = fs.readFileSync(p, 'utf8');
    reply.type('text/yaml').send(y);
  } catch (e) {
    app.log.error(e);
    reply.code(404).send('not found');
  }
});

// Redoc docs pages
app.get('/docs/bff-valet', async (_req, reply) => {
  reply.type('text/html').send(redocHtml('BFF Valet API', '/openapi/bff-valet.yaml'));
});
// Docs landing page
app.get('/docs', async (_req, reply) => {
  reply.type('text/html').send(docsIndexHtml());
});

app.get('/docs/upstream-valet', async (_req, reply) => {
  reply.type('text/html').send(redocHtml('Upstream Valet API', '/openapi/upstream-valet.yaml'));
});

// Parking and Valet proxies
app.register(proxy, { upstream: PARKING_SERVICE_URL, prefix: '/api/parking', rewritePrefix: '/parking', proxyPayloads: false });
app.register(proxy, { upstream: VALET_SERVICE_URL, prefix: '/api/valet', rewritePrefix: '/valet', proxyPayloads: false });

// Proxy public endpoints
app.register(proxy, { upstream: AUTH_SERVICE_URL, prefix: '/api/auth', rewritePrefix: '/auth', proxyPayloads: false });
app.register(proxy, { upstream: VENUE_SERVICE_URL, prefix: '/api/venues', rewritePrefix: '/venues', proxyPayloads: false });
// Proxy host onboarding to auth-service
app.register(proxy, { upstream: AUTH_SERVICE_URL, prefix: '/api/host', rewritePrefix: '/host', proxyPayloads: false });

// Example of a protected proxy (if needed later)
app.register(proxy, { upstream: VENUE_SERVICE_URL, prefix: '/api/secure/venues', rewritePrefix: '/venues', proxyPayloads: false });

const port = process.env.PORT || 3000;
if (process.env.NODE_ENV !== 'test') {
  app.listen({ port: Number(port), host: '0.0.0.0' }).catch((err) => {
    app.log.error(err);
    process.exit(1);
  });
}

// Make app/io available to tests without ESM export
// (Vitest/Vite transform may treat this file as CJS in some setups)
// Tests can access via globalThis.__bff_app and globalThis.__bff_io after importing this module.
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
globalThis.__bff_app = app;
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
globalThis.__bff_io = io;
