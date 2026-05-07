import { Router, Request, Response } from 'express';
import { requireAuth } from '../middleware/auth';
import { db } from '../lib/db';

const router = Router();

// ─── GET /providers/status ────────────────────────────────────────────────────
// Returns the authenticated user's host and valet profile status
router.get('/providers/status', requireAuth, async (req: Request, res: Response) => {
  const userId = req.user!.userId;

  const [hostProfile, valetProfile] = await Promise.all([
    db.hostProfile.findUnique({ where: { userId } }),
    db.valetProfile.findUnique({ where: { userId } }),
  ]);

  res.json({
    host: hostProfile
      ? {
          id: hostProfile.id,
          status: hostProfile.status,
          currentStep: hostProfile.currentStep,
          onboardingData: hostProfile.onboardingData,
          submittedAt: hostProfile.submittedAt,
          approvedAt: hostProfile.approvedAt,
        }
      : null,
    valet: valetProfile
      ? {
          id: valetProfile.id,
          status: valetProfile.status,
          agreementAcceptedAt: valetProfile.agreementAcceptedAt,
        }
      : null,
  });
});

// ─── POST /providers/host/progress ──────────────────────────────────────────
// Upsert host onboarding draft — saves current step + merged data
router.post('/providers/host/progress', requireAuth, async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const { currentStep, onboardingData } = req.body as {
    currentStep: number;
    onboardingData: Record<string, unknown>;
  };

  if (!currentStep || !onboardingData) {
    res.status(400).json({ error: 'currentStep and onboardingData are required' });
    return;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const jsonData = onboardingData as any;
  const profile = await db.hostProfile.upsert({
    where: { userId },
    create: {
      userId,
      status: 'draft',
      currentStep,
      onboardingData: jsonData,
    },
    update: {
      currentStep,
      onboardingData: jsonData,
    },
  });

  res.json({ profile: { id: profile.id, status: profile.status, currentStep: profile.currentStep } });
});

// ─── POST /providers/host/submit ─────────────────────────────────────────────
// Mark host application as submitted (pending review)
router.post('/providers/host/submit', requireAuth, async (req: Request, res: Response) => {
  const userId = req.user!.userId;

  const existing = await db.hostProfile.findUnique({ where: { userId } });
  if (!existing) {
    res.status(404).json({ error: 'No host profile found. Complete onboarding first.' });
    return;
  }

  const profile = await db.hostProfile.update({
    where: { userId },
    data: { status: 'pending', submittedAt: new Date() },
  });

  res.json({ profile: { id: profile.id, status: profile.status, submittedAt: profile.submittedAt } });
});

// ─── POST /providers/host/reset ──────────────────────────────────────────────
// Delete host profile (Danger Zone — allows restart of onboarding)
router.post('/providers/host/reset', requireAuth, async (req: Request, res: Response) => {
  const userId = req.user!.userId;

  await db.hostProfile.deleteMany({ where: { userId } });

  res.json({ success: true });
});

// ─── POST /providers/valet/accept-agreement ──────────────────────────────────
// Record acceptance of the independent contractor agreement
router.post('/providers/valet/accept-agreement', requireAuth, async (req: Request, res: Response) => {
  const userId = req.user!.userId;

  const profile = await db.valetProfile.upsert({
    where: { userId },
    create: {
      userId,
      status: 'active',
      agreementAcceptedAt: new Date(),
    },
    update: {
      status: 'active',
      agreementAcceptedAt: new Date(),
    },
  });

  res.json({
    profile: {
      id: profile.id,
      status: profile.status,
      agreementAcceptedAt: profile.agreementAcceptedAt,
    },
  });
});

export default router;

