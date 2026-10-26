import { randomBytes } from 'crypto';
import bcrypt from 'bcryptjs';
import { TRPCError } from '@trpc/server';
import { db } from '../lib/db';
import { VerifiedProviderIdentity } from './providerIdTokenVerifier';
import { refreshUserIdentityHashes } from './userIdentityHashes';
import { extraEmailOwnerId, normalizeEmail } from './accountEmails';
import { signupRef } from './inviteCodes';

type ProviderUser = { id: string; email: string; name: string | null };

/**
 * Either the account this identity signs in to, or the existing account that
 * owns its email. The second must be proven before the identity joins it.
 */
export type ProviderResolution =
  | { user: ProviderUser; isNewUser: boolean }
  | { linkTo: { id: string; email: string } };

export type ProviderIdentityDatabase = Pick<typeof db, '$transaction' | 'providerIdentity' | 'user' | 'userIdentityHash' | 'userEmail'>;

/**
 * A display name the app passed alongside the token. Apple puts the member's
 * name in the authorization response, never in the ID token, and only on the
 * first authorization. It is display-only, never identity proof.
 */
export function suppliedDisplayName(value: string | null | undefined): string | undefined {
  const clean = (value ?? '').replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, '').trim().slice(0, 100);
  return clean || undefined;
}

/**
 * Resolves a verified provider subject to exactly one user. An existing
 * account with the same email is never joined here: the caller must have the
 * member prove control of it first (see services/providerLink.ts), or a
 * provider email alone would open someone else's account.
 */
export async function resolveProviderIdentity(
  identity: VerifiedProviderIdentity,
  database: ProviderIdentityDatabase = db,
  { ref, suppliedName }: { ref?: string; suppliedName?: string } = {},
): Promise<ProviderResolution> {
  const name = identity.name ?? suppliedDisplayName(suppliedName);
  if (name !== identity.name) identity = { ...identity, name };
  const existing = await database.providerIdentity.findUnique({
    where: { provider_subject: { provider: identity.provider, subject: identity.subject } },
    include: { user: { select: { id: true, email: true, name: true } } },
  });
  if (existing) {
    // Fills a name the account never got; a name the member set is kept.
    if (!existing.user.name?.trim() && name) {
      const user = await database.user.update({ where: { id: existing.user.id }, data: { name }, select: { id: true, email: true, name: true } });
      return { user, isNewUser: false };
    }
    return { user: existing.user, isNewUser: false };
  }

  if (!identity.email) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'This provider did not supply an email address. Use email sign-in or contact support.',
    });
  }

  const emailOwner = await database.user.findUnique({ where: { email: identity.email }, select: { id: true, email: true } });
  if (emailOwner) return { linkTo: emailOwner };
  // An extra email is proven the same way, by a code sent to that address.
  const extraOwner = await extraEmailOwnerId(identity.email, database);
  if (extraOwner) return { linkTo: { id: extraOwner, email: normalizeEmail(identity.email) } };

  // A provider-only account cannot use password login until a future explicit
  // password-setting flow is completed. Never persist the generated secret.
  const password = await bcrypt.hash(randomBytes(32).toString('hex'), 12);
  const storedRef = await signupRef(ref, database);
  try {
    return await database.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: { email: identity.email!, emailVerifiedAt: new Date(), password, name: identity.name, ref: storedRef },
        select: { id: true, email: true, name: true },
      });
      await tx.providerIdentity.create({
        data: { provider: identity.provider, subject: identity.subject, userId: user.id },
      });
      return { user, isNewUser: true };
    }).then((result) => {
      // Identity hashes power contact-graph discovery (non-blocking)
      void refreshUserIdentityHashes(result.user.id, { email: result.user.email }, database);
      return result;
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
