/**
 * REA review 2026-11-10 (X6, P1, C3). What a member has agreed to and what
 * they have told us about their age, recorded with a version and a time so
 * App Review and counsel can see exactly what was accepted.
 */
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { config } from '../config';
import { db } from '../lib/db';
import { parseBirthDate, provenMinimumAge } from '../services/ageGate';
import { protectedProcedure, rateLimitMiddleware, router } from './trpc';

/** Named in the consent sheet and the privacy policy draft. */
export const AI_PROVIDER = 'OpenAI';

const write = protectedProcedure.use(rateLimitMiddleware({ windowMs: 60_000, max: 10, label: 'consent-write' }));

export const consentRouter = router({
  status: protectedProcedure
    .use(rateLimitMiddleware({ windowMs: 60_000, max: 60, label: 'consent-status' }))
    .query(async ({ ctx }) => {
      const user = await db.user.findUnique({
        where: { id: ctx.user.userId },
        select: { birthDate: true, ageConfirmedAt: true, termsVersion: true, termsAcceptedAt: true, aiConsentAt: true },
      });
      if (!user) throw new TRPCError({ code: 'NOT_FOUND', message: 'Account not found.' });
      const minimumAge = provenMinimumAge({ birthDate: user.birthDate, ageConfirmedAt: user.ageConfirmedAt });
      return {
        terms: {
          currentVersion: config.termsVersion,
          acceptedVersion: user.termsVersion,
          acceptedAt: user.termsAcceptedAt?.toISOString() ?? null,
          needsAcceptance: user.termsVersion !== config.termsVersion,
        },
        // Never the birth date itself: the client only needs what it unlocks.
        age: {
          hasBirthDate: Boolean(user.birthDate),
          confirmed18: (minimumAge ?? 0) >= 18,
          canEnter21Plus: (minimumAge ?? 0) >= 21 && Boolean(user.birthDate),
        },
        // REA C3 / App Review 5.1.2(i).
        ai: { provider: AI_PROVIDER, consentedAt: user.aiConsentAt?.toISOString() ?? null, required: config.conciergeRequireAiConsent },
      };
    }),

  acceptTerms: write
    .input(z.object({ version: z.string().trim().min(1).max(40) }))
    .mutation(async ({ ctx, input }) => {
      if (input.version !== config.termsVersion) {
        throw new TRPCError({ code: 'CONFLICT', message: 'The Terms changed. Reload them before accepting.' });
      }
      const acceptedAt = new Date();
      await db.user.update({ where: { id: ctx.user.userId }, data: { termsVersion: input.version, termsAcceptedAt: acceptedAt } });
      return { version: input.version, acceptedAt: acceptedAt.toISOString() };
    }),

  setAge: write
    .input(z.object({
      birthDate: z.string().trim().max(10).optional(),
      confirm18: z.literal(true).optional(),
    }).refine((value) => value.birthDate || value.confirm18, { message: 'Give a date of birth or confirm you are 18 or older.' }))
    .mutation(async ({ ctx, input }) => {
      const user = await db.user.findUnique({ where: { id: ctx.user.userId }, select: { birthDate: true, ageConfirmedAt: true } });
      if (!user) throw new TRPCError({ code: 'NOT_FOUND', message: 'Account not found.' });
      const data: { birthDate?: Date; ageConfirmedAt?: Date } = {};
      if (input.birthDate) {
        // Set once. Letting a member retype it would make the 21+ gate a
        // form to retry until it passes; support corrects real mistakes.
        if (user.birthDate) throw new TRPCError({ code: 'CONFLICT', message: 'Your date of birth is already set. Contact support to correct it.' });
        const parsed = parseBirthDate(input.birthDate);
        if ('problem' in parsed) throw new TRPCError({ code: 'BAD_REQUEST', message: parsed.problem });
        data.birthDate = parsed.date;
      }
      if (input.confirm18 && !user.ageConfirmedAt) data.ageConfirmedAt = new Date();
      if (Object.keys(data).length > 0) await db.user.update({ where: { id: ctx.user.userId }, data });
      return { ok: true as const };
    }),

  /**
   * REA C3. The member agrees (or withdraws) to have concierge requests,
   * including approximate location and preferences, sent to OpenAI.
   */
  setAiConsent: write
    .input(z.object({ consent: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      const aiConsentAt = input.consent ? new Date() : null;
      await db.user.update({ where: { id: ctx.user.userId }, data: { aiConsentAt } });
      return { consentedAt: aiConsentAt?.toISOString() ?? null };
    }),
});
