import { randomBytes } from 'crypto';
import bcrypt from 'bcryptjs';
import { TRPCError } from '@trpc/server';
import { db } from '../lib/db';
import { VerifiedProviderIdentity } from './providerIdTokenVerifier';

type ProviderUser = { id: string; email: string; name: string | null };

type ProviderIdentityDatabase = Pick<typeof db, '$transaction' | 'providerIdentity' | 'user'>;

/**
 * Resolves a verified provider subject to exactly one user. We deliberately do
 * not auto-link an existing password account by email: identity linking must be
 * an authenticated, explicit future operation to prevent account takeover.
 */
export async function resolveProviderIdentity(
  identity: VerifiedProviderIdentity,
  database: ProviderIdentityDatabase = db,
): Promise<{ user: ProviderUser; isNewUser: boolean }> {
  const existing = await database.providerIdentity.findUnique({
    where: { provider_subject: { provider: identity.provider, subject: identity.subject } },
    include: { user: { select: { id: true, email: true, name: true } } },
  });
  if (existing) return { user: existing.user, isNewUser: false };

  if (!identity.email) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'This provider did not supply an email address. Use email sign-in or contact support.',
    });
  }

  const emailOwner = await database.user.findUnique({ where: { email: identity.email }, select: { id: true } });
  if (emailOwner) {
    throw new TRPCError({
      code: 'CONFLICT',
      message: 'An account already exists for this email. Sign in with its existing method first.',
    });
  }

  // A provider-only account cannot use password login until a future explicit
  // password-setting flow is completed. Never persist the generated secret.
  const password = await bcrypt.hash(randomBytes(32).toString('hex'), 12);
  try {
    return await database.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: { email: identity.email!, password, name: identity.name },
        select: { id: true, email: true, name: true },
      });
      await tx.providerIdentity.create({
        data: { provider: identity.provider, subject: identity.subject, userId: user.id },
      });
      return { user, isNewUser: true };
    });
  } catch (error: unknown) {
    // A concurrent first sign-in may have created this identity. Re-read by
    // immutable provider subject; do not fall back to email matching.
    const concurrent = await database.providerIdentity.findUnique({
      where: { provider_subject: { provider: identity.provider, subject: identity.subject } },
      include: { user: { select: { id: true, email: true, name: true } } },
    });
    if (concurrent) return { user: concurrent.user, isNewUser: false };
    throw error;
  }
}
