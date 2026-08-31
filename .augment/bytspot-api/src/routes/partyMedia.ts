import { Router } from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../config';
import { db } from '../lib/db';

const partyMediaRouter = Router();

function requestUserId(authorization: string | undefined): string | null {
  if (!authorization?.startsWith('Bearer ')) return null;
  try {
    const token = jwt.verify(authorization.slice(7), config.jwtSecret) as { userId?: unknown };
    return typeof token.userId === 'string' ? token.userId : null;
  } catch {
    return null;
  }
}

partyMediaRouter.get('/media/parties/:mediaId', async (req, res) => {
  const media = await db.partyMedia.findUnique({
    where: { id: req.params.mediaId },
    include: { party: { select: { hostUserId: true, status: true, accessMode: true } } },
  }).catch(() => null);
  if (!media) return res.status(404).json({ error: 'Not found' });

  const owner = requestUserId(req.headers.authorization) === media.party.hostUserId;
  // Published-party cover and album are part of the invitation itself — they
  // are not a withheld location. Anyone who already has the media URL (issued
  // only via events.invite) can render it, including unsigned App Clip guests
  // on after-approval / private-approval rooms. Draft media stays host-only.
  const published = media.party.status === 'published';
  if (!owner && !published) return res.status(404).json({ error: 'Not found' });

  // Prisma 6 returns a Bytes column as Uint8Array, and Express only treats a
  // real Buffer as a binary body — a Uint8Array falls through to res.json()
  // and ships `{"0":255,"1":216,...}`, which no image decoder accepts.
  const bytes = Buffer.from(media.bytes);

  res.setHeader('Content-Type', media.mimeType);
  res.setHeader('Content-Length', String(bytes.length));
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', published ? 'public, max-age=86400' : 'private, no-store');
  // The share page is served on the share domain and cover art on the API
  // origin, so this is a cross-origin image. Helmet's default
  // Cross-Origin-Resource-Policy of same-origin makes the browser discard it
  // and the guest sees a broken poster. The share page's CSP already allows
  // this origin; CORP is a separate opt-in and was missed.
  // Only published media is relaxed. Draft media is owner-only via an
  // Authorization header, which an <img> cannot send, so it stays same-origin.
  if (published) res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  return res.status(200).send(bytes);
});

export default partyMediaRouter;