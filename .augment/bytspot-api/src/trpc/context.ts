import * as trpcExpress from '@trpc/server/adapters/express';
import jwt from 'jsonwebtoken';
import { config } from '../config';
import { AuthPayload } from '../middleware/auth';

export interface Context {
  user: AuthPayload | null;
  /** True only after the user row backing the JWT has been checked for this request. */
  authUserExists?: true;
  internal?: {
    /** Set only by the signed `/stripe/webhook` REST dispatcher after Stripe signature verification. */
    stripeWebhook?: true;
  };
  req?: trpcExpress.CreateExpressContextOptions['req'];
  res?: trpcExpress.CreateExpressContextOptions['res'];
}

/**
 * Creates the tRPC context from the Express request.
 * Extracts JWT auth if present (optional — procedures decide whether to require it).
 */
export async function createContext({
  req,
  res,
}: trpcExpress.CreateExpressContextOptions): Promise<Context> {
  let user: AuthPayload | null = null;

  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ')) {
    try {
      const token = header.slice(7);
      user = jwt.verify(token, config.jwtSecret) as AuthPayload;
    } catch {
      /* invalid token — user stays null */
    }
  }

  return { user, req, res };
}