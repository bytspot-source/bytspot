import { createPublicKey, randomBytes, type JsonWebKey } from 'crypto';
import jwt from 'jsonwebtoken';
import { TRPCError } from '@trpc/server';
import { config } from '../config';
import { db } from '../lib/db';
import { sendWelcomeEmail } from '../lib/email';
import { signAuthToken } from './vendorRbac';

type AppleJwk = JsonWebKey & { kid?: string; alg?: string };
type AppleJwtPayload = jwt.JwtPayload & {
  sub?: string;
  email?: string;
  email_verified?: string | boolean;
};

export type AppleAuthResult = {
  token: string;
  user: { id: string; email: string; name: string | null; authProvider: string };
  isNewUser: boolean;
};

let cachedKeys: { fetchedAt: number; keys: AppleJwk[] } | null = null;
const APPLE_KEYS_TTL_MS = 60 * 60 * 1000;

function assertAppleConfigured(): string[] {
  if (!config.appleClientIds.length) {
    throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'Sign in with Apple is not configured.' });
  }
  return config.appleClientIds;
}

async function getAppleJwks(): Promise<AppleJwk[]> {
  if (cachedKeys && Date.now() - cachedKeys.fetchedAt < APPLE_KEYS_TTL_MS) return cachedKeys.keys;
  const response = await fetch('https://appleid.apple.com/auth/keys');
  if (!response.ok) throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Apple session could not be verified.' });
  const payload = await response.json() as { keys?: AppleJwk[] };
  cachedKeys = { fetchedAt: Date.now(), keys: payload.keys ?? [] };
  return cachedKeys.keys;
}

async function verifyAppleIdentityToken(identityToken: string): Promise<Required<Pick<AppleJwtPayload, 'sub' | 'email'>>> {
  const allowedAudiences = assertAppleConfigured();
  const decoded = jwt.decode(identityToken, { complete: true });
  const kid = decoded && typeof decoded === 'object' ? decoded.header?.kid : undefined;
  if (!kid) throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Apple session is missing a key id.' });

  const jwk = (await getAppleJwks()).find((key) => key.kid === kid);
  if (!jwk) throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Apple session key is not recognized.' });

  const publicKey = createPublicKey({ key: jwk, format: 'jwk' }).export({ type: 'spki', format: 'pem' });
  let payload: AppleJwtPayload;
  try {
    payload = jwt.verify(identityToken, publicKey, {
      algorithms: ['RS256'],
      issuer: 'https://appleid.apple.com',
	      audience: allowedAudiences as [string, ...string[]],
    }) as AppleJwtPayload;
  } catch {
    throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Apple session could not be verified.' });
  }

  const emailVerified = payload.email_verified === true || payload.email_verified === 'true';
  if (!payload.sub || !payload.email || !emailVerified) {
    throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Apple account email is not verified.' });
  }
  return { sub: payload.sub, email: payload.email.toLowerCase() };
}

function oauthPasswordSeed(): string {
  return `oauth:apple:${randomBytes(24).toString('hex')}`;
}

export async function completeAppleSignIn(input: { identityToken: string; email?: string | null; name?: string | null; ref?: string | null }): Promise<AppleAuthResult> {
  const apple = await verifyAppleIdentityToken(input.identityToken);
  // The verified Apple JWT, not mutable client profile data, owns account identity.
  const email = apple.email;
  let isNewUser = false;
  let user = await db.user.findFirst({
    where: { OR: [{ appleSubject: apple.sub }, { email }] } as any,
  } as any) as any;

  if (!user) {
    isNewUser = true;
    user = await db.user.create({
      data: {
        email,
        name: input.name || email.split('@')[0],
        password: oauthPasswordSeed(),
        appleSubject: apple.sub,
        authProvider: 'apple',
        ref: input.ref || 'apple',
      } as any,
    } as any) as any;
    sendWelcomeEmail(user.email, (user.name || '').split(' ')[0]).catch(() => {});
  } else if (!user.appleSubject || user.authProvider !== 'apple' || (input.name && !user.name)) {
    user = await db.user.update({
      where: { id: user.id },
      data: {
        appleSubject: user.appleSubject ?? apple.sub,
        authProvider: user.authProvider === 'apple' ? 'apple' : `${user.authProvider}_apple`,
        name: user.name ?? input.name ?? null,
      } as any,
    } as any) as any;
  }

  const token = await signAuthToken(user.id, user.email);
  return {
    token,
    isNewUser,
    user: { id: user.id, email: user.email, name: user.name ?? null, authProvider: user.authProvider ?? 'apple' },
  };
}