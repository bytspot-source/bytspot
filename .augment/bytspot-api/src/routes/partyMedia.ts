import { Router } from 'express';
import type { Response } from 'express';
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

function notFound(res: Response) {
  return res.status(404).json({ error: 'Not found' });
}

// Prisma 6 returns a Bytes column as Uint8Array, and Express only treats a
// real Buffer as a binary body — a Uint8Array falls through to res.json()
// and ships `{"0":255,"1":216,...}`, which no image decoder accepts.
function sendMedia(res: Response, media: { mimeType: string; bytes: Uint8Array }, cacheControl: string, crossOrigin: boolean) {
  const bytes = Buffer.from(media.bytes);
  res.setHeader('Content-Type', media.mimeType);
  res.setHeader('Content-Length', String(bytes.length));
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', cacheControl);
  // The share page is served on the share domain and cover art on the API
  // origin, so this is a cross-origin image. Helmet's default
  // Cross-Origin-Resource-Policy of same-origin makes the browser discard it
  // and the guest sees a broken poster. The share page's CSP already allows
  // this origin; CORP is a separate opt-in and was missed.
  if (crossOrigin) res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  return res.status(200).send(bytes);
}

partyMediaRouter.get('/media/parties/:mediaId', async (req, res) => {
  const media = await db.partyMedia.findUnique({
    where: { id: req.params.mediaId },
    include: { party: { select: { id: true, hostUserId: true, status: true, accessMode: true, recapPublishedAt: true } } },
  }).catch(() => null);
  if (!media) return notFound(res);

  const viewerUserId = requestUserId(req.headers.authorization);
  const owner = viewerUserId === media.party.hostUserId;

  // A recap is the room from the inside — faces of people who were actually
  // there. Cover and album are the invitation, so for them holding the URL is
  // the whole test. A recap is a second authorization surface instead: every
  // read re-checks the guest list, so a leaked or forwarded URL grants nothing.
  if (media.kind === 'recap') {
    if (!owner) {
      // Anonymous, an invalid token, a stranger, and a host still staging all
      // collapse to the same 404 a party with no recap gives. 401 or 403 would
      // confirm the album exists.
      if (!viewerUserId || media.party.status !== 'published' || !media.party.recapPublishedAt) return notFound(res);
      const guest = await db.partyGuest.findUnique({
        where: { partyId_userId: { partyId: media.party.id, userId: viewerUserId } },
        select: { accessGranted: true },
      }).catch(() => null);
      // Admission, not attendance: accessGranted is RSVP/ticket/approval, so a
      // confirmed no-show can read the album. Same rule as the recap alert.
      if (!guest?.accessGranted) return notFound(res);
    }
    // Never cacheable and never cross-origin: authorization is per-read, and an
    // <img> cannot carry the Authorization header this requires.
    return sendMedia(res, media, 'private, no-store', false);
  }
  // Published-party cover and album are part of the invitation itself — they
  // are not a withheld location. Anyone who already has the media URL (issued
  // only via events.invite) can render it, including unsigned App Clip guests
  // on after-approval / private-approval rooms. Draft media stays host-only.
  const published = media.party.status === 'published';
  if (!owner && !published) return notFound(res);

  // Only published media is relaxed to cross-origin. Draft media is owner-only
  // via an Authorization header, which an <img> cannot send.
  return sendMedia(res, media, published ? 'public, max-age=86400' : 'private, no-store', published);
});

export default partyMediaRouter;