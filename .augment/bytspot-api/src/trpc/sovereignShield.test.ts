import { describe, it, expect, beforeEach, vi } from 'vitest';
import { db } from '../lib/db';
import { router, publicProcedure, createCallerFactory, sovereignShieldMiddleware } from './trpc';
import type { Context } from './context';

function createMockRes() {
  const headers = new Map<string, string>();
  return {
    headers,
    res: {
      setHeader: vi.fn((key: string, value: string) => {
        headers.set(String(key), String(value));
      }),
    },
  };
}

function createTestCaller(ctxOverrides: Partial<Context> = {}) {
  const testRouter = router({
    probe: publicProcedure
      .use(
        sovereignShieldMiddleware({
          entity: 'FOUNDATION',
          frameworks: ['NIST_AI_RMF_1_0', 'EO_14365'],
          stateFlags: ['GA_BH1'],
          policyContext: { surface: 'patch', mode: 'verification' },
        }),
      )
      .query(() => ({ ok: true })),
    dynamic: publicProcedure
      .use(
        sovereignShieldMiddleware({
          entity: 'EXPERIENCES',
          frameworks: ({ path, ctx }) => [
            'EO_14365',
            path.toUpperCase(),
            ctx.user?.userId ?? 'anon',
          ],
          stateFlags: ({ ctx }) => (ctx.user ? ['GA_BH1', 'AUTHENTICATED'] : ['ANON']),
          policyContext: ({ path, ctx }) => ({
            surface: 'patch',
            path,
            actor: ctx.user?.email ?? 'guest',
          }),
        }),
      )
      .query(() => ({ ok: 'dynamic' })),
  });

  const factory = createCallerFactory(testRouter);
  const ctx: Context = {
    user: { userId: 'user-1', email: 'shield@test.com' },
    req: { ip: '203.0.113.10', headers: {} } as any,
    ...ctxOverrides,
  };
  return factory(ctx);
}

describe('sovereignShieldMiddleware', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('writes an allow ComplianceLog row and stamps response headers on success', async () => {
    const { res, headers } = createMockRes();
    const caller = createTestCaller({ res: res as any });

    const result = await caller.probe();

    expect(result).toEqual({ ok: true });
    expect(db.complianceLog.create).toHaveBeenCalledOnce();
    expect(db.complianceLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: 'user-1',
        entity: 'FOUNDATION',
        procedure: 'probe',
        frameworks: ['NIST_AI_RMF_1_0', 'EO_14365'],
        stateFlags: ['GA_BH1'],
        outcome: 'allow',
        requestIp: '203.0.113.10',
        policyContext: { surface: 'patch', mode: 'verification' },
      }),
    });
    expect(headers.get('X-Sovereign-Shield')).toBe('active');
    expect(headers.get('X-Sovereign-Entity')).toBe('FOUNDATION');
    expect(headers.get('X-Sovereign-Outcome')).toBe('allow');
    expect(headers.get('X-Sovereign-Frameworks')).toBe('NIST_AI_RMF_1_0,EO_14365');
    expect(headers.get('X-Sovereign-State-Flags')).toBe('GA_BH1');
  });

  it('supports resolver-based metadata for frameworks, state flags, and policy context', async () => {
    const { res, headers } = createMockRes();
    const caller = createTestCaller({ res: res as any });

    await expect(caller.dynamic()).resolves.toEqual({ ok: 'dynamic' });

    expect(db.complianceLog.create).toHaveBeenCalledOnce();
    expect(db.complianceLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        entity: 'EXPERIENCES',
        procedure: 'dynamic',
        frameworks: ['EO_14365', 'DYNAMIC', 'user-1'],
        stateFlags: ['GA_BH1', 'AUTHENTICATED'],
        outcome: 'allow',
        policyContext: {
          surface: 'patch',
          path: 'dynamic',
          actor: 'shield@test.com',
        },
      }),
    });
    expect(headers.get('X-Sovereign-Entity')).toBe('EXPERIENCES');
    expect(headers.get('X-Sovereign-Frameworks')).toBe('EO_14365,DYNAMIC,user-1');
    expect(headers.get('X-Sovereign-State-Flags')).toBe('GA_BH1,AUTHENTICATED');
  });

  it('fails open when ComplianceLog persistence is unavailable', async () => {
    const { res, headers } = createMockRes();
    (db.complianceLog.create as any).mockRejectedValueOnce(new Error('db unavailable'));
    const caller = createTestCaller({ res: res as any });

    await expect(caller.probe()).resolves.toEqual({ ok: true });
    expect(headers.get('X-Sovereign-Outcome')).toBe('allow');
  });
});