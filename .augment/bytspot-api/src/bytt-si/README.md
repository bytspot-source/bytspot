# BYTT-SI (vendored)

Bytspot's concierge orchestration engine: one main system prompt (`prompt/system.md`) + six callable skills (`skills/`: discovery, budget, people, scheduling, routing, bookables), a swappable LLM (`llm/`: `LLMProvider`, `OpenAIProvider`, `FakeProvider`), and an orchestrator (`engine.ts`) that always returns a proposed Plan or a quick answer with "Make it a plan".

Budget, schedule feasibility and honesty rules are enforced in code (`core/`). Facts on a plan come only from ports; the model picks candidate ids.

## Why it lives here

`src/bytt-si/` is plain TypeScript compiled by the API's own `tsc` (CommonJS, `rootDir: src`) and tested by its own `npm test` (`tsx --test src/**/*.node.test.ts`, one directory deep, so tests sit directly in this folder). The repo has no npm workspaces and CI runs from `.augment/bytspot-api`, so a folder inside `src` needs no build, CI or deploy changes. `zod` v4 is already a dependency; nothing new is added. The engine core (`core/`, `llm/`, `skills/`, `ports/types.ts`, `engine.ts`, `types.ts`) imports nothing from the API, so it can still move to bytspot-ai later; only `backend/` is API-specific.

`prompt/index.ts` holds the prompt as a string so the compiled build does not need `system.md` copied into `dist`; `core.node.test.ts` fails if the two differ. Edit `system.md`, then paste it into `SYSTEM_PROMPT`.

## Backend ports (`backend/`)

| Port | Wraps | Behaviour |
|---|---|---|
| Places | `services/conciergePlaces.ts` (`conciergePlacesSearch`: Google Places, Redis cache, `cachedWithStale`) + `conciergeReconcilePlaces` | Stale results stay `google-stale` (open/closed null). Admin-hidden places dropped. `priceCents` always null (no real price source). |
| Events | `trpc/eventsRouter.ts` `nearby` (Bytspot parties, all gates) + `mapTmEvent` | Never calls `events.list` (it serves FALLBACK_EVENTS). Failure → `{ events: [], source: 'unavailable' }`. Parties carry `party:<id>` for `plans.createWithBookables`; no prices. |
| Crowd | `services/typicalOccupancy.ts` `typicalCrowd` | Typical only, at the plan hour in Atlanta. Always labelled "(typical, not live)". |
| Routing | `services/checkinProof.ts` distance; `trpc/mobilityRouter.ts` `handoffUrl` | Travel is an estimate. Uber/Lyft are hand-off links, no fares. |
| Bookables | `services/tableBookingLinks.ts` (`ensureTableBookingLinks`, `tableBookingLinkFor`) | OpenTable/Resy links, availability never checked. |
| People | `SocialCircle`/`SocialCircleMember`, `services/safety.ts` `blockedUserIds` | Caller's own circles, blocked users removed, other members' preferences not shared. |
| Final check | `services/planFeasibility.ts` + `services/planLegs.ts` `PlanLeg` | Runs on every proposal; a `breaks` or a failure to run blocks booking. |

## Prime Path

The model understands the request and names the needs. The final pick per need
is made by the existing Prime Path ranker (`services/primePath.ts`, unchanged,
including its three commitments) through `backend/primePath.ts`, wired as
`EngineOptions.ranker` in `createBackendEngine`. The engine itself only knows the
`NeedRanker` interface (`ranking.ts`); without a ranker it falls back to the v1
model selection and the plan says `ranking: 'model'`.

Candidate mapping (honest facts only):

| Field | Source |
|---|---|
| capability | bookableProjection (`capabilityForAccessMode`, applied by `eventsRouter.nearby`) or the Bytspot bookable row |
| ownInventory | true only for Bytspot parties and places with a Bytspot bookable (coffee holds are not discovered by BYTT-SI yet) |
| seats | live `spacesRemaining` for parties (never Typical); bookable capacity for bookables; unknown → 0 and not confirmable |
| minParty | stated minimum if the supply has one, else 1 |
| confirmableNow | Mode B, seats > 0, and the party's time overlaps the plan window |
| travelMinutes | RoutingPort estimate from the previous stop (or a location the guest gave); else null, which sorts last |
| reliability, continuationValue | 0 (neutral) |
| price / anything commercial | never an input |

OpenTable/Resy links, Google places and Ticketmaster events are details or deep
links. Bytspot can't confirm them and has no seat count, so they are **not** fed
to `rankPrimePath` (that would mean inventing `confirmableNow`/`seats`). They are
listed after Prime Path's ranked alternates (by travel, unknown last) and can never
be the prime.

Per need, the item carries `primePath`:

- `prime`: the ranker's pick, with its reason line (`★ Prime Path — fits 4 at 10:00 PM, 6 min away, confirmable now`). The model can't override it, and a pitch that names an unpicked stop is replaced.
- `fallback`: the prime broke the budget, so the next viable alternate (in order) was used; `note` says why.
- `suggestion`: no prime (deep-link/details only). The model's suggestion among the alternates is labeled as a suggestion and has no badge.
- `listed`: no prime and no model suggestion; the first alternate in order.

`alternates` is the decline auto-promotion order (ranked first). Paths that fail a
hard filter (seats < party, minimum party > committed, not confirmable) are
dropped, not demoted, and a `prime_path` notice says why. For an unsaved proposal
`goingCount` is 1 (only the requester has committed, and never more than the
party). `partySize` is the stated size, else the head count of a group the guest
named (people skill), else an assumed 2. An assumed size adds the notice "Assumed 2
people. Change the group size to update.", sets `partySizeSource: 'assumed'` and
`status: 'needs_changes'`, and blocks booking with reason `party_size_unconfirmed`. Budget, schedule and the final `planFeasibility`
check still run after ranking.

## Route

`concierge.plan` (`trpc/conciergePlanRouter.ts`): authenticated mutation, 10/min per user, input `{ message, location? }`, output `{ version: 1, status: 'ok' | 'unavailable', reply, result }`. Open only when `CONCIERGE_PLAN_ENABLED=true` **and** Concierge discovery is open to the user (`CONCIERGE_DISCOVERY_ENABLED`, `CONCIERGE_AUDIENCE`, `CONCIERGE_PILOT_USER_IDS`). Model: `CONCIERGE_PLAN_MODEL` (default `gpt-4o-mini`), key `OPENAI_API_KEY`. Nothing is saved or booked; the client saves via `plans.create` / `plans.createWithBookables`, and `plans.feasibility` stays authoritative.

## Swapping the LLM

Implement `LLMProvider` (`chat`, `structured`) in one file under `llm/` and pass it to `createEngine`.
