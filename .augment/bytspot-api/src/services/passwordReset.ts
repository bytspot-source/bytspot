import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { db } from '../lib/db';
import { config } from '../config';
import { sendPasswordResetEmail } from '../lib/email';

const RESET_TOKEN_BYTES = 32;
const RESET_TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour

export function hashPasswordResetToken(token: string): string {
  return crypto.createHash('sha256').update(token, 'utf8').digest('hex');
}

function buildPasswordResetUrl(token: string): string {
  const baseUrl = config.frontendUrl.replace(/\/$/, '');
  return `${baseUrl}/#/reset-password?token=${encodeURIComponent(token)}`;
}

function firstNameFrom(name: string | null | undefined): string {
  return (name || '').trim().split(/\s+/)[0] || 'there';
}

/**
 * Starts a password reset request without revealing whether the email exists.
 * Existing unused tokens for the user are marked used before a new one is sent.
 */
export async function requestPasswordReset(email: string): Promise<void> {
  const normalizedEmail = email.trim();
  const user = await db.user.findFirst({
    where: { email: { equals: normalizedEmail, mode: 'insensitive' } },
    select: { id: true, email: true, name: true },
  });

  if (!user) return;

  const rawToken = crypto.randomBytes(RESET_TOKEN_BYTES).toString('base64url');
  const tokenHash = hashPasswordResetToken(rawToken);
  const expiresAt = new Date(Date.now() + RESET_TOKEN_TTL_MS);

  await db.passwordResetToken.updateMany({
    where: { userId: user.id, usedAt: null },
    data: { usedAt: new Date() },
  });

  await db.passwordResetToken.create({
    data: { userId: user.id, tokenHash, expiresAt },
  });

  await sendPasswordResetEmail(
    user.email,
    firstNameFrom(user.name),
    buildPasswordResetUrl(rawToken),
  );
}

/** Returns true only when the token was valid, unexpired, and successfully claimed. */
export async function resetPasswordWithToken(token: string, password: string): Promise<boolean> {
  const cleanToken = token.trim();
  if (!cleanToken) return false;

  const tokenHash = hashPasswordResetToken(cleanToken);
  const resetToken = await db.passwordResetToken.findUnique({
    where: { tokenHash },
    select: { id: true, userId: true, expiresAt: true, usedAt: true },
  });

  if (!resetToken || resetToken.usedAt || resetToken.expiresAt <= new Date()) {
    return false;
  }

  const passwordHash = await bcrypt.hash(password, 12);
  const claimed = await db.passwordResetToken.updateMany({
    where: { id: resetToken.id, usedAt: null },
    data: { usedAt: new Date() },
  });

  if (claimed.count !== 1) return false;

  await db.user.update({
    where: { id: resetToken.userId },
    data: { password: passwordHash },
  });

  return true;
}
