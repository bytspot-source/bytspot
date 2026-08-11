const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const test = require('node:test');
const venuesRouter = require('../dist/routes/venues').default;

test('legacy REST venue check-in rejects unauthenticated callers before writing crowd data', async () => {
  const app = express();
  app.use(venuesRouter);
  const server = await new Promise((resolve) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  try {
    const { port } = server.address();
    const response = await new Promise((resolve, reject) => {
      const request = http.request({
        host: '127.0.0.1',
        port,
        method: 'POST',
        path: '/venues/venue-1/checkin',
      }, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => resolve({ statusCode: res.statusCode, body }));
      });
      request.on('error', reject);
      request.end();
    });
    assert.equal(response.statusCode, 401);
    assert.match(response.body, /Missing or invalid authorization header/);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
