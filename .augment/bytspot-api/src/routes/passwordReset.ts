import { NextFunction, Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { requestPasswordReset, resetPasswordWithToken } from '../services/passwordReset';

const router = Router();

const forgotSchema = z.object({
  email: z.string().email().max(255),
});

const resetSchema = z.object({
  token: z.string().min(32).max(256),
  password: z.string().min(8, 'Password must be at least 8 characters').max(128),
});

const forgotLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many password reset requests, please try again later' },
});

const resetLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many password reset attempts, please try again later' },
});

/** POST /auth/forgot — always returns success for valid email-shaped input. */
router.post('/auth/forgot', forgotLimiter, async (req, res, next: NextFunction) => {
  const parsed = forgotSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten().fieldErrors });
    return;
  }

  try {
    await requestPasswordReset(parsed.data.email);
    res.json({
      success: true,
      message: 'If an account exists for that email, a reset link has been sent.',
    });
  } catch (error) {
    next(error);
  }
});

/** POST /auth/reset — consumes a single-use reset token and rotates the password. */
router.post('/auth/reset', resetLimiter, async (req, res, next: NextFunction) => {
  const parsed = resetSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten().fieldErrors });
    return;
  }

  try {
    const success = await resetPasswordWithToken(parsed.data.token, parsed.data.password);
    if (!success) {
      res.status(400).json({ error: 'Invalid or expired reset token' });
      return;
    }

    res.json({ success: true });
  } catch (error) {
    next(error);
  }
});

export default router;
