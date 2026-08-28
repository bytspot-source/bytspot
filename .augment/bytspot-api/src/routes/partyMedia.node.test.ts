import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import express from 'express';
import helmet from 'helmet';
import partyMediaRouter from './partyMedia';
import { db } from '../lib/db';

const partyMedia = db.partyMedia as any;

const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function mediaRow(status: string) {
  return {
    id: 'media-1', mimeType: 'image/png', byteSize: pngBytes.length, bytes: pngBytes,
    party: { hostUserId: 'host-1', status, accessMode: 'paid-ticket' },
  };
}

async function get(): Promise<{ status: number; corp: string | null }> {
  const app = express();
  // Mirrors src/index.ts, where the default helmet policy applies to this route.
  app.use(helmet());
  app.use(partyMediaRouter);
  const server = app.listen(0);
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/media/parties/media-1`);
    await res.arrayBuffer();
    return { status: res.status, corp: res.headers.get('cross-origin-resource-policy') };
  } finally {
    server.close();
  }
}

beforeEach(() => {
  partyMedia.findUnique = async () => mediaRow('published');
});

// The share page renders on the share domain while cover art is served from the
// API origin. Helmet's default same-origin CORP makes the browser discard the
// image, which is why a published poster showed as a broken image.
test('published party media is readable cross-origin', async () => {
  const res = await get();
  assert.equal(res.status, 200);
  assert.equal(res.corp, 'cross-origin');
});

test('draft media stays same-origin', async () => {
  // Draft media is owner-only and unreachable from an <img>, which cannot send
  // an Authorization header, so it must not be relaxed.
  partyMedia.findUnique = async () => mediaRow('draft');
  const res = await get();
  assert.equal(res.status, 404);
  assert.notEqual(res.corp, 'cross-origin');
});
