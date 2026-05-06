import { randomBytes } from 'crypto';
import { TRPCError } from '@trpc/server';
import { config } from '../config';
import { db } from '../lib/db';
import { sendWelcomeEmail } from '../lib/email';
import { signAuthToken } from './vendorRbac';

export type GoogleAuthSurface = 'parker' | 'provider-onboarding';

export type GoogleAuthResult = {
  token: string;
  user: { id: string; email: string; name: string | null; authProvider: string };
  isNewUser: boolean;
};

type GoogleTokenInfo = {
  sub?: string;
  email?: string;
  email_verified?: string | boolean;
  name?: string;
  aud?: string;
};

function assertGoogleConfigured(): string[] {
  if (!config.googleClientIds.length) {
    throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'Google Sign-In is not configured.' });
  }
  return config.googleClientIds;
}

async function verifyGoogleIdToken(idToken: string): Promise<Required<Pick<GoogleTokenInfo, 'sub' | 'email'>> & Pick<GoogleTokenInfo, 'name' | 'aud'>> {
  const allowedAudiences = assertGoogleConfigured();
  const response = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(idToken)}`);
  if (!response.ok) {
    throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Google session could not be verified.' });
  }
  const payload = await response.json() as GoogleTokenInfo;
  const emailVerified = payload.email_verified === true || payload.email_verified === 'true';
  if (!payload.sub || !payload.email || !emailVerified) {
    throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Google account email is not verified.' });
  }
  if (!payload.aud || !allowedAudiences.includes(payload.aud)) {
    throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Google session audience is not allowed for Bytspot.' });
  }
  return { sub: payload.sub, email: payload.email.toLowerCase(), name: payload.name, aud: payload.aud };
}

function oauthPasswordSeed(): string {
  return `oauth:google:${randomBytes(24).toString('hex')}`;
}

export async function completeGoogleSignIn(input: { idToken: string; ref?: string | null; surface?: GoogleAuthSurface }): Promise<GoogleAuthResult> {
  const google = await verifyGoogleIdToken(input.idToken);
  let isNewUser = false;
  let user = await db.user.findFirst({
    where: { OR: [{ googleSubject: google.sub }, { email: google.email }] } as any,
  } as any) as any;

  if (!user) {
    isNewUser = true;
    user = await db.user.create({
      data: {
        email: google.email,
        name: google.name ?? google.email.split('@')[0],
        password: oauthPasswordSeed(),
        googleSubject: google.sub,
        authProvider: 'google',
        ref: input.ref || input.surface || 'google',
      } as any,
    } as any) as any;
    sendWelcomeEmail(user.email, (user.name || '').split(' ')[0]).catch(() => {});
  } else if (!user.googleSubject || user.authProvider !== 'google' || (google.name && !user.name)) {
    user = await db.user.update({
      where: { id: user.id },
      data: {
        googleSubject: user.googleSubject ?? google.sub,
        authProvider: user.authProvider === 'google' ? 'google' : 'password_google',
        name: user.name ?? google.name ?? null,
      } as any,
    } as any) as any;
  }

  const token = await signAuthToken(user.id, user.email);
  return {
    token,
    isNewUser,
    user: { id: user.id, email: user.email, name: user.name ?? null, authProvider: user.authProvider ?? 'google' },
  };
}
