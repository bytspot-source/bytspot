# Concierge opening suggestions

Contract for the iOS concierge chips. Replaces the hardcoded "Coffee nearby", "Dinner tonight", and "Something to do nearby" row.

`concierge.suggestions` is an authenticated tRPC **query**, 30 requests per user per minute. It does not search places and does not save a Plan.

## When it answers

Same gate as `concierge.discover`:

| Env | Effect |
| --- | --- |
| `CONCIERGE_DISCOVERY_ENABLED` | Must be `true`. Default `false`. |
| `CONCIERGE_AUDIENCE` | `pilot` (default) or `everyone`. |
| `CONCIERGE_PILOT_USER_IDS` | Comma-separated **user ids**, never emails. Empty + `pilot` opens Concierge to no one. |

Anyone outside that gate gets `status: "unavailable"`, `suggestions: []`, and the same "not enabled" reply as discovery. No model call.

`CONCIERGE_PLAN_ENABLED` does not gate this query. It decides whether a chip may use `destination: "concierge_plan"`. That route is also pilot-gated. Without `OPENAI_API_KEY`, `concierge.plan` answers unavailable and these chips stay on the curated list (`source: "curated"`).

A missing location, a missing model key, a declined AI consent, or a failed model call still returns three suggestions. The list is empty only when the gate is closed.

## Input

| Field | Type |
| --- | --- |
| `location` | Optional `{ lat, lng }`. Same coordinate rules as `concierge.discover`. Omit it when the guest has not confirmed a location. |

Unknown fields are rejected.

## Output

`version` is `1`. `status` is `ok` or `unavailable`.

When `status` is `ok`:

| Field | Meaning |
| --- | --- |
| `source` | `si` when the model chose the ids. `curated` when the server used the fixed list. The words are server-written either way. |
| `reply` | `null` |
| `area.label` | `Midtown`, `Atlanta`, `Midtown Atlanta`, or `null` |
| `area.basis` | `coordinates` when `location` was sent. `launch_market` when it was not. The launch market is an assumption, not a detected neighborhood. |
| `area.sentence` | Show this if you mention the area. It already says when the location was not shared. |
| `when` | `{ timezone: "America/New_York", hour, dayOfWeek, weekday }`. `dayOfWeek` is 0 (Sunday) through 6. |
| `primePath.status` | `ok` if Bytspot parties near the guest were ranked. `unavailable` means the check did not run. That is not "nothing nearby". |
| `primePath.confirmableNeeds` | Needs the existing Prime Path ranker can feature (`coffee`, `dining`, `nightlife`, `events`). Empty when status is `unavailable`. |
| `suggestions` | 1–3 chips. One has `startsPlan: true`. |

Each suggestion:

| Field | Meaning |
| --- | --- |
| `id` | Stable id. `plan_the_night` is always present and first. |
| `label` | Chip title. |
| `prompt` | The exact user message to send. Do not send the label unless it equals `prompt`. |
| `reason` | One server-written explanation. It includes "Typical for this hour in Atlanta, not a live reading." whenever `typical` is set. |
| `destination` | Where a tap goes. See below. |
| `startsPlan` | The prompt is a Plan request, not a single place search. |
| `planId` | Set only for `destination: "share_plan"`. |
| `typical` | `null`, or `{ category, level, label, source: "typical", note, hourLabel }`. `source` is always `typical`. `note` is always "Typical for this hour in Atlanta, not a live reading." `level` is 1–4 (`Chill`, `Active`, `Busy`, `Packed`). This is the usual level for that hour in Atlanta. It is not a live count, a wait, or a scarcity claim. |
| `primePath.note` | The only sentence that may mention Prime Path. `null` means do not say Prime Path featured a stop. When set, the pick is on `concierge.plan`, not on Discover cards. |
| `primePath.confirmableNeeds` | The overlap between this chip and the ranked needs. |
| `primePath.consulted` | The ranker ran. A chip can be consulted with an empty overlap. |

### Where a tap goes

| `destination` | Client call |
| --- | --- |
| `discover` | `concierge.discover` with `messages: [{ role: "user", content: prompt }]`, and `location` when the guest has confirmed one. |
| `concierge_plan` | `concierge.plan` with `{ message: prompt, location? }`. This is the BYTT-SI plan. Prime Path makes the final pick per need. Requires `CONCIERGE_PLAN_ENABLED` and the pilot gate. |
| `share_plan` | Open the existing Plan `planId` and its share link. Do not send `prompt` to Discover. |

`plan_the_night` uses `destination: "discover"` and `prompt: "Plan dinner and drinks tonight"`. A ready Discover response then includes `proposedPlan` (dinner and drinks). Nothing is saved until the guest confirms. Saving is still `plans.create` (title, intent, needs, party size, area) and `plans.attach` per stop, then `plans.feasibility`. The share link is the Plan's existing invite link. The chip does not send it.

Show `typical.note` next to any crowd word. Do not relabel it as live, "right now", or a wait time.

## Discover phrases that already return a Proposed Plan

These are rewritten on the server before search, including for older builds that still send the old chip text:

| Guest text | Treated as |
| --- | --- |
| `Dinner tonight` | `Plan dinner tonight` (one-stop Proposed Plan) |
| `Plan the night`, `Plan my night`, `Plan our night` | `Plan dinner and drinks tonight` |
| `Something to do nearby` | `Events nearby` (a search, not a Plan) |
| `Help plan tonight` | Unchanged. One restaurant, not a Proposed Plan. |

A Plan that says "in Midtown", from a guest within 80 km of Midtown Atlanta, still runs when Google cannot place Midtown. The reply says the search used the launch-market point. It does not say Google placed it.

## Flags to turn the chips and Plans on

Do not put emails in `CONCIERGE_PILOT_USER_IDS`.

```
CONCIERGE_DISCOVERY_ENABLED=true
CONCIERGE_AUDIENCE=pilot
CONCIERGE_PILOT_USER_IDS=<user id>,<user id>
CONCIERGE_PLAN_ENABLED=true
OPENAI_API_KEY=<set on the server>
GOOGLE_PLACES_API_KEY=<set on the server>
```

`CONCIERGE_AUDIENCE=everyone` skips the id list. An open audience also requires a confirmed email before `concierge.plan` runs. `CONCIERGE_REQUIRE_AI_CONSENT=true` requires `consent.setAiConsent` before any model call. Suggestions then stay on the curated list and are not sent to the model.

`CONCIERGE_PLAN_MODEL` defaults to `gpt-4o-mini`.
