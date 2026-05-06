import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { db } from '../lib/db';
import { sendWelcomeEmail } from '../lib/email';
import { requireAuth } from '../middleware/auth';
import { signAuthToken } from '../auth/vendorRbac';
import { completeGoogleSignIn } from '../auth/google';

const router = Router();

const signupSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8, 'Password must be at least 8 characters'),
  name: z.string().optional(),
  ref: z.string().optional(),
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string(),
});

const googleSchema = z.object({
  idToken: z.string().min(20),
  ref: z.string().max(100).optional(),
  surface: z.enum(['parker', 'provider-onboarding']).optional(),
});

/** POST /auth/signup */
router.post('/auth/signup', async (req, res) => {
  const parsed = signupSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten().fieldErrors });
    return;
  }

  const { email, password, name, ref } = parsed.data;

  const existing = await db.user.findUnique({ where: { email } });
  if (existing) {
    res.status(409).json({ error: 'Email already registered' });
    return;
  }

  const hashed = await bcrypt.hash(password, 12);
  const user = await db.user.create({
    data: { email, password: hashed, name, ref },
  });

  const token = await signAuthToken(user.id, user.email);

  // Send welcome email (non-blocking — fire and forget)
  if (user.email) {
    const firstName = (name || '').split(' ')[0];
    sendWelcomeEmail(user.email, firstName).catch(() => {});
  }

  res.status(201).json({
    token,
    user: { id: user.id, email: user.email, name: user.name },
  });
});

/** POST /auth/login */
router.post('/auth/login', async (req, res) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten().fieldErrors });
    return;
  }

  const { email, password } = parsed.data;
  const user = await db.user.findUnique({ where: { email } });
  if (!user) {
    res.status(401).json({ error: 'Invalid email or password' });
    return;
  }

  const valid = await bcrypt.compare(password, user.password);
  if (!valid) {
    res.status(401).json({ error: 'Invalid email or password' });
    return;
  }

  const token = await signAuthToken(user.id, user.email);
  res.json({
    token,
    user: { id: user.id, email: user.email, name: user.name },
  });
});

/** POST /auth/google — Google Identity Services ID token sign-in */
router.post('/auth/google', async (req, res) => {
  const parsed = googleSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten().fieldErrors });
    return;
  }
  const result = await completeGoogleSignIn(parsed.data);
  res.status(result.isNewUser ? 201 : 200).json(result);
});

/** GET /auth/me — returns current user profile + referral stats */
router.get('/auth/me', requireAuth, async (req, res) => {
  const userId = req.user!.userId;

  const user = await db.user.findUnique({
    where: { id: userId },
    select: { id: true, email: true, name: true, ref: true, createdAt: true },
  });

  if (!user) {
    res.status(404).json({ error: 'User not found' });
    return;
  }

  // Count how many users signed up with ref = this user's ID
  const referralCount = await db.user.count({
    where: { ref: userId },
  });

  res.json({
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      ref: user.ref,
      createdAt: user.createdAt,
    },
    referralCount,
  });
});

export default router;
