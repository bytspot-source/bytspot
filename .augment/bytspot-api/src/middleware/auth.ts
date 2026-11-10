import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { isSessionRevoked, isTokenSignedOut } from '../services/accountDeletion';
import { isSessionSuspended, SUSPENDED_MESSAGE } from '../services/safety';
import { config } from '../config';

export interface AuthPayload {
  userId: string;
  email: string;
  /** Issued-at, in seconds. Set by jsonwebtoken on every token it signs. */
  iat?: number;
}

declare global {
  namespace Express {
    interface Request {
      user?: AuthPayload;
    }
  }
}

/** Require valid JWT Bearer token */
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Missing or invalid authorization header' });
    return;
  }

  let payload: AuthPayload;
  try {
    payload = jwt.verify(header.slice(7), config.jwtSecret) as AuthPayload;
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
    return;
  }
  // REA X8: the same session checks as tRPC's protectedProcedure, so a
  // deleted, suspended or signed-out account can't keep using REST routes.
  void (async () => {
    if (await isSessionRevoked(payload.userId)) return 'This account is pending deletion';
    if (await isSessionSuspended(payload.userId)) return SUSPENDED_MESSAGE;
    if (await isTokenSignedOut(payload.userId, payload.iat)) return 'Your password was changed. Sign in again.';
    return null;
  })().then((refusal) => {
    if (refusal) { res.status(401).json({ error: refusal }); return; }
    req.user = payload;
    next();
  }, next);
}

/** Optional auth — attaches user if token present, continues either way */
export function optionalAuth(req: Request, _res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ')) {
    try {
      const token = header.slice(7);
      req.user = jwt.verify(token, config.jwtSecret) as AuthPayload;
    } catch {
      /* ignore invalid token */
    }
  }
  next();
}
