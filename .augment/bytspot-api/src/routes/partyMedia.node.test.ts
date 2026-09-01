import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import express from 'express';
import helmet from 'helmet';
import jwt from 'jsonwebtoken';
import partyMediaRouter from './partyMedia';
import { config } from '../config';
import { db } from '../lib/db';

const partyMedia = db.partyMedia as any;
const partyGuest = db.partyGuest as any;

// Signed with the same secret the route verifies against.
function bearer(userId: string): string {
  return `Bearer ${jwt.sign({ userId }, config.jwtSecret)}`;
}

const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function mediaRow(status: string) {
  return {
    id: 'media-1', kind: 'cover', mimeType: 'image/png', byteSize: pngBytes.length, bytes: pngBytes,
    party: { id: 'party-1', hostUserId: 'host-1', status, accessMode: 'paid-ticket', recapPublishedAt: null },
  };
}

function recapRow(overrides: { status?: string; recapPublishedAt?: Date | null } = {}) {
  const row = mediaRow(overrides.status ?? 'published');
  // Explicit null means staged, so it must not fall back to a publish date.
  const recapPublishedAt = 'recapPublishedAt' in overrides ? overrides.recapPublishedAt : new Date();
  return { ...row, kind: 'recap', party: { ...row.party, recapPublishedAt } };
}

async function get(authorization?: string): Promise<{ status: number; corp: string | null; contentType: string | null; cacheControl: string | null; body: Buffer }> {
  const app = express();
  // Mirrors src/index.ts, where the default helmet policy applies to this route.
  app.use(helmet());
  app.use(partyMediaRouter);
  const server = app.listen(0);
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/media/parties/media-1`, {
      headers: authorization ? { authorization } : {},
    });
    const body = Buffer.from(await res.arrayBuffer());
    return {
      status: res.status,
      corp: res.headers.get('cross-origin-resource-policy'),
      contentType: res.headers.get('content-type'),
      cacheControl: res.headers.get('cache-control'),
      body,
    };
  } finally {
    server.close();
  }
}

beforeEach(() => {
  partyMedia.findUnique = async () => mediaRow('published');
  partyGuest.findUnique = async () => null;
});

// The share page renders on the share domain while cover art is served from the
// API origin. Helmet's default same-origin CORP makes the browser discard the
// image, which is why a published poster showed as a broken image.
test('published party media is readable cross-origin', async () => {
  const res = await get();
  assert.equal(res.status, 200);
  assert.equal(res.corp, 'cross-origin');
});

// Prisma 6 hands back a Uint8Array for a Bytes column, not a Buffer. Express
// only recognises a real Buffer as a binary body, so the raw column value was
// serialised as `{"0":255,"1":216,...}` — a 12x larger payload that no image
// decoder accepts, which is why every published cover rendered broken.
test('party media is served as raw binary, not a JSON-serialised byte map', async () => {
  partyMedia.findUnique = async () => ({ ...mediaRow('published'), bytes: new Uint8Array(pngBytes) });
  const res = await get();
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, pngBytes);
  assert.equal(res.contentType, 'image/png');
});

test('draft media stays same-origin', async () => {
  // Draft media is owner-only and unreachable from an <img>, which cannot send
  // an Authorization header, so it must not be relaxed.
  partyMedia.findUnique = async () => mediaRow('draft');
  const res = await get();
  assert.equal(res.status, 404);
  assert.notEqual(res.corp, 'cross-origin');
});

// A recap is the room from the inside, not the invitation. Holding the URL is
// enough for cover and album; for a recap every read re-checks the guest list.
test('a recap is withheld from everyone the door did not admit', async () => {
  partyMedia.findUnique = async () => recapRow();

  // Anonymous, and an invalid token, which must be read as anonymous.
  assert.equal((await get()).status, 404);
  assert.equal((await get('Bearer not-a-jwt')).status, 404);

  // A signed-in stranger with no guest row.
  assert.equal((await get(bearer('usr_stranger'))).status, 404);

  // A guest row that exists but was never granted access — pending, declined,
  // or withdrawn. Still the same 404 a party with no recap gives.
  partyGuest.findUnique = async () => ({ accessGranted: false });
  assert.equal((await get(bearer('usr_pending'))).status, 404);
});

test('a confirmed guest reads the recap, privately and same-origin', async () => {
  partyMedia.findUnique = async () => recapRow();
  partyGuest.findUnique = async () => ({ accessGranted: true });
  const res = await get(bearer('usr_guest'));
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, pngBytes);
  // Authorization is re-checked per read, so the response must not be cached
  // and must not be reachable from a cross-origin <img>, which cannot send the
  // header in the first place.
  assert.equal(res.cacheControl, 'private, no-store');
  assert.notEqual(res.corp, 'cross-origin');
});

test('a host reads a staged recap, and nobody else knows it exists', async () => {
  partyMedia.findUnique = async () => recapRow({ recapPublishedAt: null });
  assert.equal((await get(bearer('host-1'))).status, 200);

  // Staging is indistinguishable from no recap, even for a confirmed guest.
  partyGuest.findUnique = async () => ({ accessGranted: true });
  assert.equal((await get(bearer('usr_guest'))).status, 404);
});

test('a recap stops being readable if the party leaves published', async () => {
  // Recap rows can only be created on a published party today, so this pins the
  // guard rather than a reachable bug: if an unpublish path is ever added, the
  // bytes route must stop serving instead of trusting accessGranted alone.
  partyMedia.findUnique = async () => recapRow({ status: 'draft' });
  partyGuest.findUnique = async () => ({ accessGranted: true });
  assert.equal((await get(bearer('usr_guest'))).status, 404);
  // The host still reviews their own album.
  assert.equal((await get(bearer('host-1'))).status, 200);
});
