import { test, strict as assert } from 'node:test';
import http from 'node:http';
import app from '../app.js';

function listen(app) {
  return new Promise((resolve) => {
    const server = http.createServer(app);
    server.listen(0, () => resolve(server));
  });
}

async function fetchUrl(base, path) {
  const res = await fetch(new URL(path, base));
  const text = await res.text();
  return { status: res.status, text };
}

test('GET /healthz and /health return 200 ok', async (t) => {
  const server = await listen(app);
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const r1 = await fetchUrl(base, '/healthz');
    assert.equal(r1.status, 200);
    assert.equal(r1.text, 'ok');

    const r2 = await fetchUrl(base, '/health');
    assert.equal(r2.status, 200);
    assert.equal(r2.text, 'ok');
  } finally {
    server.close();
  }
});

