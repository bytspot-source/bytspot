import assert from 'node:assert/strict';
import test from 'node:test';

import { appRouter } from './router';
import { createCallerFactory, RATE_LIMIT_LABEL } from './trpc';
import type { Context } from './context';

/**
 * Router-wide audits. Every other test in this suite proves a property of one
 * endpoint and leaves the reader to infer it holds for the rest; these two
 * enumerate the surface instead, so a new mutation has to opt out by name
 * rather than by being forgotten.
 */

const anonymous: Context = { user: null, clientRateLimitKey: 'router-surface-audit' };

type ProcedureInternals = { _def: { type: string; middlewares: unknown[] } };
const procedures = appRouter._def.procedures as unknown as Record<string, ProcedureInternals>;

const mutations = Object.entries(procedures)
  .filter(([, procedure]) => procedure._def.type === 'mutation')
  .map(([path]) => path);

/** Mutations that are unauthenticated by design. Anything else must reject. */
const PUBLIC_MUTATIONS = new Set([
  'auth.signup', 'auth.login', 'auth.appleSignIn', 'auth.googleSignIn',
  'betaSignup.signup',
  'push.subscribe',
  'admin.validateInvite',
  'subscription.webhook',
  // Guarded by the cron secret rather than a session; see routes/cron.ts.
  'cron.crowdAlerts', 'cron.crowdSim',
]);

/**
 * Mutations with no rate limiter today. This list is a ratchet, not an
 * endorsement: it exists so the next unlimited mutation fails here instead of
 * shipping. Removing an entry is the fix; adding one needs a reason.
 */
const UNLIMITED_MUTATIONS = new Set([
  'providers.submitHostApplication', 'providers.resetHostProfile', 'providers.acceptValetAgreement',
  'admin.validateInvite', 'push.subscribe',
  'cron.crowdAlerts', 'cron.crowdSim',
  'user.savedSpots.save', 'user.savedSpots.remove', 'user.savedSpots.createCollection', 'user.savedSpots.addToCollection',
  'user.preferences.update', 'user.preferences.trackBehavior', 'user.profile.update',
  'user.vehicles.add', 'user.vehicles.update', 'user.vehicles.remove',
  'user.notifications.updatePrefs', 'user.account.requestDeletion', 'user.account.cancelDeletion',
  'events.hostDestinations.save', 'events.media.reset', 'events.arrival.bindDestination',
  'mobility.reservations.cancel', 'mobility.trips.status',
  'providers.saveHostProgress',
]);

test('Every mutation is authenticated unless it is named as public', async () => {
  const caller = createCallerFactory(appRouter)(anonymous) as Record<string, unknown>;
  const reachable: string[] = [];

  for (const path of mutations) {
    const procedure = path.split('.').reduce<any>((node, key) => node?.[key], caller) as (input: unknown) => Promise<unknown>;
    try {
      // Auth runs ahead of input parsing, so an empty input still reaches it.
      await procedure({});
      reachable.push(path);
    } catch (error) {
      if ((error as { code?: string }).code !== 'UNAUTHORIZED') reachable.push(path);
    }
  }

  assert.deepEqual(reachable.sort(), [...PUBLIC_MUTATIONS].sort());
});

test('Every mutation carries a rate limiter unless it is named as unlimited', () => {
  const unlimited = mutations.filter((path) => (
    !procedures[path]._def.middlewares.some((middleware) => RATE_LIMIT_LABEL in (middleware as object))
  ));

  assert.deepEqual(unlimited.sort(), [...UNLIMITED_MUTATIONS].sort());
});
