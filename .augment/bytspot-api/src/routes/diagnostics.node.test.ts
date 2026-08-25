import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import diagnosticsRouter from './diagnostics';

function app() {
  const instance = express();
  instance.use(express.json());
  instance.use(diagnosticsRouter);
  return instance;
}

async function post(body: unknown): Promise<{ status: number; body: any }> {
  const server = app().listen(0);
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/diagnostics/ios`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  } finally {
    server.close();
  }
}

test('A crash report is accepted without a session, because a crash during sign-in has none', async () => {
  const result = await post({ payloads: [{ kind: 'crash', signal: 'SIGSEGV', appVersion: '1.4.0' }] });
  assert.equal(result.status, 202);
  assert.deepEqual(result.body, { accepted: 1 });
});

test('An unrecognised diagnostic kind is rejected rather than forwarded', async () => {
  const result = await post({ payloads: [{ kind: 'keystrokes' }] });
  assert.equal(result.status, 400);
});

test('Oversized and overlong reports are refused, so the route cannot be used as a log firehose', async () => {
  const tooMany = await post({ payloads: Array.from({ length: 21 }, () => ({ kind: 'hang' })) });
  assert.equal(tooMany.status, 400);

  const tooLong = await post({ payloads: [{ kind: 'crash', callStackSummary: 'x'.repeat(4001) }] });
  assert.equal(tooLong.status, 400);
});

test('Fields the app was never allowed to send are dropped, not stored', async () => {
  const result = await post({
    payloads: [{ kind: 'crash', email: 'someone@example.com', token: 'secret-value', latitude: 33.78 }],
  });
  assert.equal(result.status, 202);
  assert.deepEqual(result.body, { accepted: 1 });
});
