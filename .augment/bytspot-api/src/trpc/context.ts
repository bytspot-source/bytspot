import * as trpcExpress from '@trpc/server/adapters/express';
import jwt from 'jsonwebtoken';
import { config } from '../config';
import { AuthPayload } from '../middleware/auth';

/**
 * Creates the tRPC context from the Express request.
 * Extracts JWT auth if present (optional — procedures decide whether to require it).
 */
export async function createContext({
  req,
}: trpcExpress.CreateExpressContextOptions) {
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

  return { user };
}

export type Context = Awaited<ReturnType<typeof createContext>>;

