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
  const publicParty = media.party.status === 'published' && media.party.accessMode !== 'private-approval';
  if (!owner && !publicParty) return res.status(404).json({ error: 'Not found' });

  res.setHeader('Content-Type', media.mimeType);
  res.setHeader('Content-Length', String(media.byteSize));
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', publicParty ? 'public, max-age=86400' : 'private, no-store');
  return res.status(200).send(media.bytes);
});

export default partyMediaRouter;