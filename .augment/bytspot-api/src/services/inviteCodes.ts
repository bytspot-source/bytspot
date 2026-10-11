import { randomInt } from 'crypto';
import { Prisma } from '@prisma/client';
import { db } from '../lib/db';

/**
 * Member invite codes. A friend types the code (or opens a link carrying it)
 * when signing up, and the new account's `ref` becomes the inviter's id, which
 * is what auth.me counts as referrals.
 */

// No 0/O, 1/I/L: the code is read aloud and typed by hand.
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const INVITE_CODE_LENGTH = 6;
const CODE_PATTERN = new RegExp(`^[${ALPHABET}]{${INVITE_CODE_LENGTH}}$`);

export const INVITE_LINK_BASE = 'https://bytspot.app/?ref=';

export type InviteCodeDatabase = Pick<typeof db, 'user'>;

export function generateInviteCode(): string {
  let code = '';
  for (let i = 0; i < INVITE_CODE_LENGTH; i++) code += ALPHABET[randomInt(ALPHABET.length)];
  return code;
}

/** The member's invite code, issued on first request. */
export async function inviteCodeFor(userId: string, database: InviteCodeDatabase = db): Promise<string> {
  const user = await database.user.findUnique({ where: { id: userId }, select: { inviteCode: true } });
  if (!user) throw new Error(`No user ${userId}`);
  if (user.inviteCode) return user.inviteCode;

  for (let attempt = 0; attempt < 5; attempt++) {
    const code = generateInviteCode();
    try {
      const updated = await database.user.updateMany({ where: { id: userId, inviteCode: null }, data: { inviteCode: code } });
      if (updated.count === 1) return code;
      // A concurrent request issued one first.
      const current = await database.user.findUnique({ where: { id: userId }, select: { inviteCode: true } });
      if (current?.inviteCode) return current.inviteCode;
    } catch (error) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002')) throw error;
    }
  }
  throw new Error('Could not issue a unique invite code');
}

/**
 * What a signup stores as `ref`. An invite code (any letter case) becomes the
 * inviter's id; a member id from older links stays as it is; anything else is
 * a campaign source ("qr", "vibecheck") and is kept unchanged.
 */
export async function signupRef(ref: string | null | undefined, database: InviteCodeDatabase = db): Promise<string | undefined> {
  const trimmed = ref?.trim();
  if (!trimmed) return undefined;
  const code = trimmed.toUpperCase();
  if (CODE_PATTERN.test(code)) {
    const inviter = await database.user.findUnique({ where: { inviteCode: code }, select: { id: true } });
    if (inviter) return inviter.id;
  }
  return trimmed;
}
