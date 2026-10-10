import { TRPCError } from '@trpc/server';
import { db } from '../lib/db';
import { requireRedis } from '../vendor/redisHandle';
import { AUTH } from '../vendor/contract';

/**
 * A member's emails: one account email (`User.email`), which everything
 * Bytspot sends goes to, and up to MAX_EXTRA_EMAILS confirmed extra emails
 * (`UserEmail`). Every confirmed email signs in, resets the password, starts
 * an Apple/Google link and is matched in contact discovery.
 *
 * Extra emails need a confirmed account email first. An unconfirmed account
 * may belong to someone who signed up with another person's address, and an
 * extra email would let them keep a way in after the real owner claims it.
 */

export const MAX_EXTRA_EMAILS = 5;

export type AccountEmailsDatabase = Pick<typeof db, '$transaction' | 'user' | 'userEmail'>;

export type AccountEmails = {
  accountEmail: { email: string; confirmed: boolean };
  extraEmails: { email: string; addedAt: Date }[];
  maxExtraEmails: number;
};

export const normalizeEmail = (email: string): string => email.trim().toLowerCase();

const isUniqueViolation = (error: unknown): boolean => (
  typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === 'P2002'
);

const inUseElsewhere = () => new TRPCError({ code: 'CONFLICT', message: 'This email is already used by another Bytspot account.' });

/**
 * The account an extra email belongs to. Account emails are still matched
 * exactly by `User.email`, as before extra emails existed.
 */
export async function extraEmailOwnerId(email: string, database: Pick<typeof db, 'userEmail'> = db): Promise<string | null> {
  const row = await database.userEmail.findUnique({ where: { email: normalizeEmail(email) }, select: { userId: true } });
  return row?.userId ?? null;
}

/** The account holding this address in either table, ignoring letter case. */
export async function addressHolderId(email: string, database: Pick<typeof db, 'user' | 'userEmail'> = db): Promise<string | null> {
  const normalized = normalizeEmail(email);
  const [account, extra] = await Promise.all([
    database.user.findFirst({ where: { email: { equals: normalized, mode: 'insensitive' } }, select: { id: true } }),
    database.userEmail.findUnique({ where: { email: normalized }, select: { userId: true } }),
  ]);
  return account?.id ?? extra?.userId ?? null;
}

export async function accountEmails(userId: string, database: AccountEmailsDatabase = db): Promise<AccountEmails> {
  const [user, extras] = await Promise.all([
    database.user.findUnique({ where: { id: userId }, select: { email: true, emailVerifiedAt: true } }),
    database.userEmail.findMany({ where: { userId }, select: { email: true, createdAt: true }, orderBy: { createdAt: 'asc' } }),
  ]);
  if (!user) throw new TRPCError({ code: 'NOT_FOUND', message: 'User not found' });
  return {
    accountEmail: { email: user.email, confirmed: user.emailVerifiedAt !== null },
    extraEmails: extras.map((extra) => ({ email: extra.email, addedAt: extra.createdAt })),
    maxExtraEmails: MAX_EXTRA_EMAILS,
  };
}

export type PendingEmail = { email: string; makeAccountEmail: boolean };

const pendingKey = (challengeId: string) => `email:pending:${challengeId}`;

/** The address waiting on its emailed code, for as long as the code lives. */
export async function holdPendingEmail(challengeId: string, pending: PendingEmail): Promise<void> {
  await requireRedis().set(pendingKey(challengeId), JSON.stringify(pending), 'EX', AUTH.code.ttlSecs);
}

export async function takePendingEmail(challengeId: string): Promise<PendingEmail | null> {
  const raw = await requireRedis().getdel(pendingKey(challengeId));
  return raw ? (JSON.parse(raw) as PendingEmail) : null;
}

/**
 * Why this address can't be added to this account, if it can't. `inUse` is
 * kept apart from the others: it is about another account, so the caller must
 * not reveal it to the member before they prove they own the mailbox.
 */
export async function extraEmailRefusal(
  userId: string,
  email: string,
  database: AccountEmailsDatabase = db,
): Promise<{ refusal: TRPCError } | { inUse: true } | null> {
  const normalized = normalizeEmail(email);
  const emails = await accountEmails(userId, database);
  if (emails.accountEmail.email.toLowerCase() === normalized || emails.extraEmails.some((extra) => extra.email === normalized)) {
    return { refusal: new TRPCError({ code: 'BAD_REQUEST', message: 'This email is already on your account.' }) };
  }
  if (!emails.accountEmail.confirmed) {
    return { refusal: new TRPCError({ code: 'PRECONDITION_FAILED', message: 'Confirm your account email first.' }) };
  }
  if (emails.extraEmails.length >= MAX_EXTRA_EMAILS) {
    return { refusal: new TRPCError({ code: 'PRECONDITION_FAILED', message: `You can add up to ${MAX_EXTRA_EMAILS} emails. Remove one first.` }) };
  }
  if (await addressHolderId(normalized, database)) return { inUse: true };
  return null;
}

/** Adds an extra email whose code the member entered. */
export async function addExtraEmail(userId: string, email: string, database: AccountEmailsDatabase = db): Promise<void> {
  const verdict = await extraEmailRefusal(userId, email, database);
  if (verdict && 'refusal' in verdict) throw verdict.refusal;
  if (verdict) throw inUseElsewhere();
  try {
    await database.userEmail.create({ data: { userId, email: normalizeEmail(email) } });
  } catch (error) {
    if (isUniqueViolation(error)) throw inUseElsewhere();
    throw error;
  }
}

/**
 * Makes a confirmed extra email the account email. The old account email
 * becomes an extra email, so nothing that signed in before stops working.
 */
export async function makeAccountEmail(
  userId: string,
  email: string,
  database: AccountEmailsDatabase = db,
): Promise<{ previous: string; current: string }> {
  const normalized = normalizeEmail(email);
  const user = await database.user.findUnique({ where: { id: userId }, select: { email: true } });
  if (!user) throw new TRPCError({ code: 'NOT_FOUND', message: 'User not found' });
  if (user.email.toLowerCase() === normalized) return { previous: user.email, current: user.email };

  const extra = await database.userEmail.findFirst({ where: { userId, email: normalized }, select: { id: true } });
  if (!extra) throw new TRPCError({ code: 'NOT_FOUND', message: 'Add and confirm this email first.' });
  try {
    await database.$transaction([
      database.userEmail.delete({ where: { id: extra.id } }),
      database.user.update({ where: { id: userId }, data: { email: normalized } }),
      database.userEmail.create({ data: { userId, email: normalizeEmail(user.email) } }),
    ]);
  } catch (error) {
    if (isUniqueViolation(error)) throw inUseElsewhere();
    throw error;
  }
  return { previous: user.email, current: normalized };
}

/** Removes an extra email. The account email stays until another one replaces it. */
export async function removeExtraEmail(userId: string, email: string, database: AccountEmailsDatabase = db): Promise<void> {
  const normalized = normalizeEmail(email);
  const user = await database.user.findUnique({ where: { id: userId }, select: { email: true } });
  if (!user) throw new TRPCError({ code: 'NOT_FOUND', message: 'User not found' });
  if (user.email.toLowerCase() === normalized) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'Make another email your account email first.' });
  }
  await database.userEmail.deleteMany({ where: { userId, email: normalized } });
}
