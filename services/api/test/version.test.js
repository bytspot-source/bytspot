import { test, strict as assert } from 'node:test';
import http from 'node:http';
import app from '../app.js';

function listen(app) {
  return new Promise((resolve) => {
    const server = http.createServer(app);
    server.listen(0, () => resolve(server));
  });
}

test('GET /version returns json with version', async () => {
  const server = await listen(app);
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const res = await fetch(new URL('/version', base));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(typeof body.version === 'string');
  } finally {
    server.close();
  }
});

