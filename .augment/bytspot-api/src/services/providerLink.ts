import { TRPCError } from '@trpc/server';
import type { AuthProvider } from '@prisma/client';
import { db } from '../lib/db';
import { requireRedis } from '../vendor/redisHandle';
import { AUTH } from '../vendor/contract';

/**
 * Adding an Apple or Google sign-in to an existing account. Linking is never
 * decided by a matching email alone: the member proves control of the account
 * first, either by a session (Settings) or by an emailed code (sign-in).
 */

export type ProviderLink = { provider: AuthProvider; subject: string };

export type SignInMethods = { password: boolean; apple: boolean; google: boolean };

export type ProviderLinkDatabase = Pick<typeof db, 'providerIdentity' | 'user'>;

export const providerTitle = (provider: AuthProvider): string => (provider === 'apple' ? 'Apple' : 'Google');

/**
 * Carried as the cause of the sign-in CONFLICT so the error formatter can tell
 * the app which code to ask for. Older apps read only the code and message.
 */
export class ProviderLinkRequired extends Error {
  constructor(readonly challengeId: string, readonly maskedEmail: string, readonly provider: AuthProvider) {
    super('Provider link required');
  }
}

/** "ama@bytspot.com" → "a••@bytspot.com": enough to recognise, not to harvest. */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf('@');
  if (at < 1) return email;
  const local = email.slice(0, at);
  return `${local[0]}${'•'.repeat(Math.min(Math.max(local.length - 1, 1), 6))}${email.slice(at)}`;
}

const pendingKey = (challengeId: string) => `link:pending:${challengeId}`;

/** The verified provider identity waiting on the emailed code, for as long as the code lives. */
export async function holdPendingLink(challengeId: string, link: ProviderLink): Promise<void> {
  await requireRedis().set(pendingKey(challengeId), JSON.stringify({ provider: link.provider, subject: link.subject }), 'EX', AUTH.code.ttlSecs);
}

export async function takePendingLink(challengeId: string): Promise<ProviderLink | null> {
  const raw = await requireRedis().getdel(pendingKey(challengeId));
  return raw ? (JSON.parse(raw) as ProviderLink) : null;
}

/**
 * Adds a provider identity to an account whose control the caller has already
 * proven. One identity per provider per account, and never one that another
 * account already uses: merging two accounts is not something linking does.
 */
export async function attachProviderIdentity(
  userId: string,
  link: ProviderLink,
  database: ProviderLinkDatabase = db,
): Promise<'attached' | 'already'> {
  const title = providerTitle(link.provider);
  const usedElsewhere = () => new TRPCError({ code: 'CONFLICT', message: `This ${title} ID is already used by another Bytspot account.` });
  const where = { provider_subject: { provider: link.provider, subject: link.subject } };

  const holder = await database.providerIdentity.findUnique({ where, select: { userId: true } });
  if (holder) {
    if (holder.userId === userId) return 'already';
    throw usedElsewhere();
  }
  const sameProvider = await database.providerIdentity.findFirst({ where: { userId, provider: link.provider }, select: { id: true } });
  if (sameProvider) {
    throw new TRPCError({ code: 'CONFLICT', message: `This account already uses a different ${title} ID. Remove it in Settings first.` });
  }
  try {
    await database.providerIdentity.create({ data: { provider: link.provider, subject: link.subject, userId } });
  } catch (error) {
    // A concurrent link of the same identity; re-read rather than guess.
    const raced = await database.providerIdentity.findUnique({ where, select: { userId: true } });
    if (raced?.userId === userId) return 'already';
    if (raced) throw usedElsewhere();
    throw error;
  }
  return 'attached';
}

export async function signInMethods(userId: string, database: ProviderLinkDatabase = db): Promise<SignInMethods> {
  const [user, identities] = await Promise.all([
    database.user.findUnique({ where: { id: userId }, select: { passwordSetAt: true } }),
    database.providerIdentity.findMany({ where: { userId }, select: { provider: true } }),
  ]);
  if (!user) throw new TRPCError({ code: 'NOT_FOUND', message: 'User not found' });
  return {
    password: user.passwordSetAt !== null,
    apple: identities.some((identity) => identity.provider === 'apple'),
    google: identities.some((identity) => identity.provider === 'google'),
  };
}

/** Removes a provider sign-in, but never the last way into the account. */
export async function detachProviderIdentity(
  userId: string,
  provider: AuthProvider,
  database: ProviderLinkDatabase = db,
): Promise<SignInMethods> {
  const methods = await signInMethods(userId, database);
  if (!methods[provider]) return methods;
  const remaining = { ...methods, [provider]: false };
  if (!remaining.password && !remaining.apple && !remaining.google) {
    throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'Add another way to sign in before removing this one.' });
  }
  await database.providerIdentity.deleteMany({ where: { userId, provider } });
  return remaining;
}
