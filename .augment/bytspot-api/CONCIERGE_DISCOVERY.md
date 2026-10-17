# Release A: text-only Concierge discovery

## Endpoint

`concierge.discover` is an authenticated tRPC **mutation**, limited to 20 requests per user per minute. `concierge.chat` retains its existing input, output and implementation. No database schema, dependency, or provider additions. The companion native implementation is in bytspot-beta PR #148. Production deployment settings have not been changed.

The new route is **disabled by default**. Set `CONCIERGE_DISCOVERY_ENABLED=true` in the API environment for an approved TestFlight pilot; `false` stops discovery before any model/catalog/provider search. Legacy `concierge.chat` is unaffected. Enable the API before distributing the paired native build.

## Exact input contract

| Field | Type / validation |
| --- | --- |
| `messages` | Array of 1–10 messages; at least one user message |
| `messages[].role` | `user` or `assistant` |
| `messages[].content` | String, at most 2,000 characters before trimming; nonempty after trimming |
| `location` | Optional object; omit to receive `needs_location` |
| `location.lat` | Finite number in [-90, 90] |
| `location.lng` | Finite number in [-180, 180] |
| `quizAnswers` | Optional object |
| `quizAnswers.vibe` | Optional string, at most 40 characters after trimming |
| `quizAnswers.walk` | Optional string, at most 40 characters after trimming |
| `quizAnswers.group` | Optional string, at most 40 characters after trimming |

Objects reject unknown fields, including legacy client-supplied `venues`. Null coordinates are not accepted. Oversized history is rejected, not silently truncated. The legacy chat input is unchanged.

## Exact output contract

| Field | Type |
| --- | --- |
| `version` | Literal number `1` |
| `reply` | String; deterministic server-written text, not model prose |
| `status` | `ready`, `needs_location`, `unavailable`, or `empty` |
| `cards` | Array of 0–3 cards |
| `refinements` | String array, currently at most 3 entries (schema permits 4) |

Each card contains exactly:

| Field | Type / meaning |
| --- | --- |
| `id` | String: Bytspot venue ID or `gp:<Google place ID>` |
| `kind` | `venue` or `place` |
| `placeId` | String or null; bare Google ID, without `places/` |
| `name`, `address` | Strings from the catalog or provider |
| `lat`, `lng` | Finite geographic coordinates |
| `category` | String from the catalog or provider primary type; `place` if absent |
| `rating` | Number in [0,5] or null; only actual provider ratings |
| `isOpen` | Boolean or null; null for stale or unknown information |
| `photoUrl` | String or null in the contract; **always null in Release A** |
| `crowd` | Always null |
| `reasons` | String array of at most 3 evidence-based reasons |
| `capability` | Always `details` |
| `source` | `bytspot`, `google`, or `google-stale` |
| `rail` | One of the 13 shared discovery rail strings below |

Rails: `explore`, `eat_drink`, `shop_style`, `experience`, `social`, `events`, `wellness`, `create_learn`, `nightlife`, `stay`, `move`, `celebrate`, `services`. Canonical category aliases mirror the read-only beta discovery-taxonomy contract v1. Google primary-type aliases are mapped additionally. Unknown categories remain visible under `explore`. Rails never grant capabilities.

## Status and evidence rules

- Missing location: `needs_location`, no cards and no discovery database, model or provider calls. Normal authentication and rate-limit Redis checks still apply.
- A named or ambiguous location: `needs_location` before searching. No geocoder or city-coordinate inference is used. Refinements and acknowledgements do not provide consent; the user must choose coordinates and explicitly confirm `Use my current location`. A new standalone nearby request replaces the older search intent.
- `ready`: at least one real card. Partial failures are disclosed in the reply.
- `empty`: both discovery sources completed and no matching in-radius candidates were found.
- `unavailable`: no cards and a source failed, is unconfigured, or only an empty stale result is available. Never relabel an outage as an empty neighborhood.
- Shared Google identities prefer Bytspot. A separate catalog lookup reconciles up to 20 Google IDs regardless of the text match: hidden catalog identities are suppressed and visible identities retain their canonical IDs. If that lookup fails, external results are withheld. Discover's existing same-name/75-meter match is also reused. Provider duplicates are removed.
- A merged Bytspot card keeps `source: bytspot`; if its Google evidence is stale, both the reply and evidence reasons disclose caching and `isOpen` is null.
- No prices, menus, dietary safety, dish quality, crowd levels, reservations, orders, event schedules or synthetic supply are asserted. Events/celebrations search venue listings, not event inventory.

## Planning, search and limits

Release A optionally uses the existing OpenAI integration for a bounded structured search plan. The strict plan schema allows only `query`, `rail`, `mode`, `needsLocation`, `budget`, `menu`, `openNow`, and `firstStop`. Extra fields, unsupported rails, unsafe/oversized queries, invented query terms, lost search constraints, coordinates, IDs, URLs, evidence and reply text are rejected. Coordinates and radius remain server-owned. Assistant history is ignored as authority. Model output never supplies a card or a reply.

Without a key, or on invalid output/provider failure/timeout, deterministic planning preserves useful free-text searches: `Find dumplings near me`, unknown dishes, `Dinner nearby`, `coffee nearby`, `pizza`, `find "Blue Bottle"`, and `called Starbucks`. Unknown words alone are not missing location. Explicit locality phrases and common bare cities are blocked before planning; the model can flag additional ambiguous localities. This is not a geocoder and cannot recognize every bare city without the model. Names and search text permit letters, numbers, spaces, apostrophes, ampersands, periods and hyphens, up to 120 characters.

`Help plan tonight` searches a restaurant as a first stop and explains that multi-stop planning/bookings are not supported. `Closer`, budget, dietary, `with outdoor seating`, and `make it spicy` refinements retain intent; `within walking distance` narrows the radius rather than being treated as a named city; a new standalone request replaces older intent and constraints. Budget requests receive a caveat, never a price-ranking promise. Dish/unknown-search requests always disclose unverified menus and dietary suitability. Negated terms are excluded from positive searches and listing names/categories; ambiguous negative-only or unsafe requests return `empty` with a concrete clarification, not `needs_location`. Exclusions cannot verify menus or every preference. Open-now requests include only fresh, positive Google opening evidence. Suggested refinements are `Closer`, `Coffee nearby`, and `Restaurants nearby`, not `Cheaper`.

- At most **one** planner/model call (1.2-second deadline, abort signal, transport timeout and no retries), then at most **one** Google text search per request, with no retries. Missing location and deterministic location clarifications call neither.
- Default radius 2,000 m; onboarding walk preferences reuse Discover's 800–5,000 m radii. `Closer` reduces the radius to at most 800 m, with a 400 m floor. All searches are bounded to 5,000 m.
- Categorical Google Text Search uses a geographic rectangle; explicitly named-place searches use a location bias as required by Google's API. Both Google and catalog candidates undergo exact spherical-distance filtering against the supplied coordinates, including date-line/polar cases.
- Catalog queries require `discoverable: true`, a geographic bounding box and name/category matching. Generic categories match exact aliases rather than arbitrary name substrings (a bar search must not match a barber). Known unrelated categories are excluded from the final set. At most 200 rows are examined, then sorted by distance; very dense catalog areas may therefore omit candidates. Merged candidates sort by distance regardless of source; Bytspot is preferred only for a shared identity.
- Cache key includes exact coordinates, normalized query hash, search mode, radius, result limit and shape version. Exact coordinates favor isolation but reduce shared cache reuse; location-cell optimization is deferred. Existing Redis fresh/stale helpers are reused: 15-minute fresh cache, seven-day stale fallback.
- Google fetch timeout: 8 seconds. Service response deadlines: 3 seconds for initial catalog reads, 9 seconds for Places/cache, then at most 3 seconds for identity reconciliation. Prisma reads cannot be cancelled here and may finish after their deadline.
- Existing Places field mapping is reused, but no photos, editorial text, reviews, booking links or additional providers are requested. Error/stale logs do not include raw queries, provider response bodies or model content.
- Group preference is accepted for contract compatibility but does not imply verified group suitability. The default-off `CONCIERGE_DISCOVERY_ENABLED` flag gates rollout.

## Validation

Focused tests are in `src/services/conciergeDiscovery.node.test.ts`, `src/services/conciergePlaces.node.test.ts` and `src/trpc/conciergeRouter.node.test.ts`. Existing `placesCache.node.test.ts` exercises actual fresh-to-stale fallback; the router-surface audit covers authentication/rate-limit attachment for the new endpoint.

Run from `.augment/bytspot-api`:

1. `npx tsx --test src/services/conciergeDiscovery.node.test.ts src/services/conciergePlaces.node.test.ts src/trpc/conciergeRouter.node.test.ts src/trpc/placesCache.node.test.ts src/trpc/routerSurface.node.test.ts`
2. `npm run typecheck`
3. `npm test`

Validation executed on October 17, 2026:

- `npm run typecheck`: exit 0 (production and test TypeScript).
- Focused Concierge tests, including adapter identity reconciliation: **48 passed, 0 failed**, exit 0.
- `npm test`: **1,076 passed, 0 failed, 47 skipped**, exit 0. Database-dependent skipped tests are not counted as passing.
- Companion iOS work: native-root/taxonomy gates, web type-check/lint, 534 web tests, and App Store bundle/purity checks passed locally. Swift/XCTest run on the PR's macOS CI; physical-device TestFlight verification is still required.

## Deliberately deferred

Photo upload/identification, verified menu/review evidence, budget ranking, event-session inventory, vendor bookable requests, Plan writes and cross-category itineraries are not implemented in Release A. The thirteen rails classify **place listings**, not guaranteed inventory across every rail. An authorized operator must approve pilot activation; nothing has been deployed or enabled by this implementation.
