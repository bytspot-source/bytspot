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

  res.setHeader('Content-Type', media.mimeType);
  res.setHeader('Content-Length', String(media.byteSize));
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', published ? 'public, max-age=86400' : 'private, no-store');
  return res.status(200).send(media.bytes);
});

export default partyMediaRouter;