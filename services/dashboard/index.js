import express from 'express';
import http from 'node:http';
import https from 'node:https';

const app = express();
const PORT = process.env.PORT || 8080;
const API_URL = process.env.API_URL || '';

app.use(express.json());
app.get('/healthz', (req, res) => res.status(200).send('ok'));

app.use('/', express.static('public', { extensions: ['html'] }));

// SSE proxy for local simplicity; in prod consider direct CORS from API
app.get('/stream', (req, res) => {
  if (!API_URL) return res.status(503).send('API_URL not configured');
  const isHttps = API_URL.startsWith('https://');
  const client = (isHttps ? https : http);
  const url = new URL('/api/v1/valet/stream', API_URL);

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  const upstream = client.request(url, (up) => {
    up.on('data', (chunk) => res.write(chunk));
    up.on('end', () => res.end());
  });
  upstream.on('error', () => res.end());
  upstream.end();

  req.on('close', () => res.end());
});

// REST proxy helpers
async function proxyJson(req, res, targetPath) {
  if (!API_URL) return res.status(503).json({ error: 'api_unset' });
  try {
    const url = new URL(targetPath, API_URL);
    if (req.query && Object.keys(req.query).length) {
      for (const [k, v] of Object.entries(req.query)) url.searchParams.set(k, v);
    }
    const headers = { 'content-type': 'application/json' };
    if (req.headers['idempotency-key']) headers['idempotency-key'] = req.headers['idempotency-key'];
    const init = { method: req.method, headers };
    if (req.method !== 'GET' && req.method !== 'HEAD') init.body = JSON.stringify(req.body || {});
    const r = await fetch(url, init);
    const text = await r.text();
    res.status(r.status);
    res.setHeader('content-type', r.headers.get('content-type') || 'application/json');
    return res.send(text);
  } catch (e) {
    console.error('proxy error', e);
    return res.status(502).json({ error: 'bad_gateway' });
  }
}

app.get('/api/valet/orders', (req, res) => proxyJson(req, res, '/api/v1/valet/orders'));
app.get('/api/valet/orders/:id', (req, res) => proxyJson(req, res, `/api/v1/valet/orders/${req.params.id}`));
app.get('/api/valet/orders/:id/events', (req, res) => proxyJson(req, res, `/api/v1/valet/orders/${req.params.id}/events`));
app.post('/api/valet/orders', (req, res) => proxyJson(req, res, '/api/v1/valet/orders'));
app.post('/api/valet/orders/:id/events', (req, res) => proxyJson(req, res, `/api/v1/valet/orders/${req.params.id}/events`));

app.listen(PORT, () => console.log(`Dashboard listening on ${PORT}, API_URL=${API_URL || 'unset'}`));
