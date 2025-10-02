import express from 'express';
import { router as valetRouter, eventBus } from './routes/valet.js';
import { parseAuth } from './middleware/auth.js';

const app = express();
app.use(express.json());
app.use(parseAuth); // Parse Authorization header into req.auth (no-op if absent)

// Health & meta
app.get('/healthz', (req, res) => res.status(200).send('ok'));
app.get('/health', (req, res) => res.status(200).send('ok'));
app.get('/version', (req, res) => res.json({ version: process.env.GIT_SHA || 'dev' }));

// SSE stream for real-time order updates (beta; in-memory broadcast)
app.get('/api/v1/valet/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  // Initial comment to open the stream in some proxies
  res.write(': connected\n\n');

  // Heartbeat to keep the connection alive through load balancers
  const heartbeat = setInterval(() => {
    try { res.write(': keep-alive\n\n'); } catch {}
  }, 25000);

  const onEvent = (evt) => {
    res.write(`event: ${evt.type}\n`);
    res.write(`data: ${JSON.stringify(evt.data)}\n\n`);
  };
  eventBus.on('order_event', onEvent);

  req.on('close', () => {
    clearInterval(heartbeat);
    eventBus.off('order_event', onEvent);
    res.end();
  });
});

// API routes
app.use('/api/v1/valet', valetRouter);

export default app;

