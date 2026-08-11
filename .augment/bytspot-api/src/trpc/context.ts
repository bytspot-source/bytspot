import * as trpcExpress from '@trpc/server/adapters/express';
import { createHash } from 'crypto';
import jwt from 'jsonwebtoken';
import { config } from '../config';
import { AuthPayload } from '../middleware/auth';

/**
 * Creates the tRPC context from the Express request.
 * Extracts JWT auth if present (optional — procedures decide whether to require it).
 */
export function clientRateLimitKey(ipAddress: string | undefined): string {
  // `req.ip` is proxy-aware because index.ts trusts the Cloudflare → Render
  // chain. Hash it so neither context nor Redis contains raw IP addresses.
  const normalized = ipAddress?.trim() || 'unknown';
  return createHash('sha256').update(normalized).digest('hex');
}

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

  return { user, clientRateLimitKey: clientRateLimitKey(req.ip) };
}

export type Context = Awaited<ReturnType<typeof createContext>>;

