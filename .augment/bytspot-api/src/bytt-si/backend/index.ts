/**
 * Production wiring of BYTT-SI inside bytspot-api. Everything here is a thin
 * default for the injectable adapters next to it; tests use the adapters with
 * fake deps and never touch the database, Redis, Google or OpenAI.
 */
import { config } from '../../config';
import { db } from '../../lib/db';
import { conciergeReconcilePlaces } from '../../services/conciergeDiscoveryAdapters';
import { conciergePlacesSearch } from '../../services/conciergePlaces';
import { blockedUserIds } from '../../services/safety';
import { ensureTableBookingLinks, tableBookingLinkFor } from '../../services/tableBookingLinks';
import type { Context } from '../../trpc/context';
import { eventsRouter } from '../../trpc/eventsRouter';
import { createEngine, type ByttSiEngine } from '../engine';
import { OpenAIProvider } from '../llm/openai';
import type { Ports } from '../ports/types';
import { createBackendBookablesPort } from './bookables';
import { createBackendCrowdPort } from './crowd';
import { createBackendEventsPort, ticketmasterEventsNoFallback } from './events';
import { backendFinalCheck } from './finalCheck';
import { createBackendPeoplePort } from './people';
import { createBackendPlacesPort } from './places';
import { createBackendRoutingPort } from './routing';

/** Ports for one signed-in request. Events go through eventsRouter so its membership, circle and block gates apply. */
export function createBackendPorts(ctx: Context): Ports {
  return {
    places: createBackendPlacesPort({ search: conciergePlacesSearch, reconcile: conciergeReconcilePlaces }),
    events: createBackendEventsPort({
      nearbyParties: async ({ lat, lng, radiusMiles }) => (await eventsRouter.createCaller(ctx).nearby({ lat, lng, radiusMiles, limit: 20 })).parties,
      ticketmaster: () => ticketmasterEventsNoFallback({ apiKey: config.ticketmasterApiKey }),
    }),
    routing: createBackendRoutingPort(),
    bookables: createBackendBookablesPort({ ensure: () => ensureTableBookingLinks(), linkFor: tableBookingLinkFor }),
    people: createBackendPeoplePort({
      circleMembers: async (userId) => (await db.socialCircleMember.findMany({
        where: { circle: { ownerId: userId }, user: { deletedAt: null, suspendedAt: null } },
        select: { userId: true, user: { select: { name: true } } },
        take: 200,
      })).map((row) => ({ userId: row.userId, name: row.user.name })),
      blocked: blockedUserIds,
    }),
    crowd: createBackendCrowdPort(),
  };
}

/** The engine for a request, or null when no OpenAI key is configured (the route then says so). */
export function createBackendEngine(ctx: Context): ByttSiEngine | null {
  if (!config.openaiApiKey) return null;
  return createEngine({
    llm: new OpenAIProvider({ apiKey: config.openaiApiKey, model: config.conciergePlanModel }),
    ports: createBackendPorts(ctx),
    finalCheck: backendFinalCheck,
  });
}
