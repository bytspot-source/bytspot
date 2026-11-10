import * as trpcExpress from '@trpc/server/adapters/express';
import { createHmac } from 'crypto';
import jwt from 'jsonwebtoken';
import { config } from '../config';
import { AuthPayload } from '../middleware/auth';
import { rateLimitSubject } from './trpc';

/**
 * Creates the tRPC context from the Express request.
 * Extracts JWT auth if present (optional — procedures decide whether to require it).
 */
export function clientRateLimitKey(ipAddress: string | undefined, secret = config.jwtSecret): string {
  // `req.ip` is proxy-aware because index.ts trusts the Cloudflare → Render
  // chain. HMAC it so neither context nor Redis contains raw IPs or a
  // dictionary-reversible unsalted IP digest.
  const normalized = ipAddress?.trim() || 'unknown';
  return createHmac('sha256', secret).update(normalized).digest('hex');
}

/** The signed-in user a request's Bearer token proves, or null. */
export function bearerUser(header: string | undefined): AuthPayload | null {
  if (!header?.startsWith('Bearer ')) return null;
  try {
    return jwt.verify(header.slice(7), config.jwtSecret) as AuthPayload;
  } catch {
    return null; /* invalid token — user stays null */
  }
}

/** Global limiter key: signed-in users by account, so people behind one shared
 *  address (a home network, a carrier gateway) do not use up each other's allowance. */
export function globalRateLimitKey(req: { headers: { authorization?: string }; ip?: string }): string {
  return rateLimitSubject(bearerUser(req.headers.authorization)?.userId, clientRateLimitKey(req.ip));
}

/**
 * Which client made the call. Only used to keep Apple-only rules (3.1.1: no
 * Stripe subscription for a digital unlock inside the iOS app) and never as a
 * security boundary: a caller can say anything here.
 */
export type ClientPlatform = 'ios' | 'web' | 'unknown';
export function clientPlatformOf(headers: Record<string, string | string[] | undefined>): ClientPlatform {
  const declared = String(headers['x-bytspot-client'] ?? '').toLowerCase();
  if (declared === 'ios' || declared === 'ios-clip') return 'ios';
  const agent = String(headers['user-agent'] ?? '');
  // URLSession's default agent: "Bytspot/1.1 CFNetwork/1494 Darwin/23.0.0".
  if (/CFNetwork\/|Darwin\//.test(agent)) return 'ios';
  if (declared === 'web') return 'web';
  return 'unknown';
}

export async function createContext({
  req,
}: trpcExpress.CreateExpressContextOptions): Promise<{ user: AuthPayload | null; clientRateLimitKey: string; clientPlatform?: ClientPlatform }> {
  const user = bearerUser(req.headers.authorization);
  return { user, clientRateLimitKey: clientRateLimitKey(req.ip), clientPlatform: clientPlatformOf(req.headers) };
}

export type Context = Awaited<ReturnType<typeof createContext>>;

