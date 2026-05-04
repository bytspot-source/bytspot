import bcrypt from 'bcryptjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../lib/db';
import { sendPasswordResetEmail } from '../lib/email';
import {
  hashPasswordResetToken,
  requestPasswordReset,
  resetPasswordWithToken,
} from './passwordReset';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('password reset service', () => {
  it('does not reveal whether an email exists', async () => {
    (db.user.findFirst as any).mockResolvedValueOnce(null);

    await requestPasswordReset('missing@test.com');

    expect(db.user.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { email: { equals: 'missing@test.com', mode: 'insensitive' } },
    }));
    expect(db.passwordResetToken.create).not.toHaveBeenCalled();
    expect(sendPasswordResetEmail).not.toHaveBeenCalled();
  });

  it('creates a single-use token and sends a reset link for existing users', async () => {
    (db.user.findFirst as any).mockResolvedValueOnce({
      id: 'user-1',
      email: 'alice@test.com',
      name: 'Alice Example',
    });

    await requestPasswordReset(' ALICE@test.com ');

    expect(db.passwordResetToken.updateMany).toHaveBeenCalledWith({
      where: { userId: 'user-1', usedAt: null },
      data: { usedAt: expect.any(Date) },
    });
    expect(db.passwordResetToken.create).toHaveBeenCalledWith({
      data: {
        userId: 'user-1',
        tokenHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        expiresAt: expect.any(Date),
      },
    });

    const tokenHash = (db.passwordResetToken.create as any).mock.calls[0][0].data.tokenHash;
    const resetUrl = (sendPasswordResetEmail as any).mock.calls[0][2];
    expect(sendPasswordResetEmail).toHaveBeenCalledWith('alice@test.com', 'Alice', expect.any(String));
    expect(resetUrl).toContain('/#/reset-password?token=');
    expect(resetUrl).not.toContain(tokenHash);
  });

  it('resets the password when the token is valid and unexpired', async () => {
    const token = 'valid-reset-token';
    (db.passwordResetToken.findUnique as any).mockResolvedValueOnce({
      id: 'prt-1',
      userId: 'user-1',
      expiresAt: new Date(Date.now() + 60_000),
      usedAt: null,
    });
    (db.passwordResetToken.updateMany as any).mockResolvedValueOnce({ count: 1 });
    (db.user.update as any).mockResolvedValueOnce({ id: 'user-1' });

    const result = await resetPasswordWithToken(token, 'new-password-123');

    expect(result).toBe(true);
    expect(db.passwordResetToken.findUnique).toHaveBeenCalledWith({
      where: { tokenHash: hashPasswordResetToken(token) },
      select: { id: true, userId: true, expiresAt: true, usedAt: true },
    });
    const passwordHash = (db.user.update as any).mock.calls[0][0].data.password;
    await expect(bcrypt.compare('new-password-123', passwordHash)).resolves.toBe(true);
  });

  it('rejects expired or already-used tokens without updating the user', async () => {
    (db.passwordResetToken.findUnique as any).mockResolvedValueOnce({
      id: 'expired',
      userId: 'user-1',
      expiresAt: new Date(Date.now() - 1),
      usedAt: null,
    });

    await expect(resetPasswordWithToken('expired-token', 'new-password-123')).resolves.toBe(false);
    expect(db.user.update).not.toHaveBeenCalled();

    (db.passwordResetToken.findUnique as any).mockResolvedValueOnce({
      id: 'used',
      userId: 'user-1',
      expiresAt: new Date(Date.now() + 60_000),
      usedAt: new Date(),
    });

    await expect(resetPasswordWithToken('used-token', 'new-password-123')).resolves.toBe(false);
    expect(db.user.update).not.toHaveBeenCalled();
  });
});
