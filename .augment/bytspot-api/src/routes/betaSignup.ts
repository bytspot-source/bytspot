/**
 * POST /beta-signup
 *
 * Pre-registration email capture from bytspot.com funnel.
 * Accepts { email, name?, source? }, saves to beta_leads, fires a
 * Resend welcome email, and returns { ok, alreadyRegistered }.
 *
 * Idempotent — submitting the same email twice is safe.
 */

import { Router } from 'express';
import { z } from 'zod';
import { db } from '../lib/db';
import { sendBetaLeadEmail } from '../lib/email';

const router = Router();

const schema = z.object({
  email:  z.string().email('Invalid email address'),
  name:   z.string().max(100).optional(),
  source: z.string().max(100).optional(),
});

router.post('/beta-signup', async (req, res) => {
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten().fieldErrors });
    return;
  }

  const { email, name, source } = parsed.data;

  try {
    // Check for existing lead — idempotent, never throw on duplicate
    const existing = await db.betaLead.findUnique({ where: { email } });

    if (existing) {
      res.json({ ok: true, alreadyRegistered: true });
      return;
    }

    await db.betaLead.create({
      data: { email, name, source: source ?? 'bytspot.com' },
    });

    // Fire welcome email immediately — non-blocking, never fails the request
    const firstName = (name ?? '').split(' ')[0].trim();
    sendBetaLeadEmail(email, firstName).catch(() => {});

    res.status(201).json({ ok: true, alreadyRegistered: false });
  } catch (err: any) {
    console.error('[beta-signup] error:', err?.message);
    res.status(500).json({ error: 'Failed to save signup. Please try again.' });
  }
});

export default router;

