# Architecture

## System overview

```
┌───────────────────────────┐
│  iOS app (native SwiftUI)  │
│                            │
│  • Chat screen             │
│  • Timetable (day/week)    │
│  • Profile / routine       │
│  • Speech → text (on-dev)  │
│  • MapKit (render + nav)   │
└─────────────┬──────────────┘
              │ HTTPS, authenticated with the user's Supabase JWT
              │ (the app holds NO third-party API keys)
              ▼
┌──────────────────────────────────────────────────────────────┐
│  Supabase                                                      │
│                                                                │
│  ┌────────────┐  ┌─────────────┐  ┌──────────────────────┐    │
│  │ Auth (JWT) │  │ Postgres    │  │ Edge Functions        │    │
│  │            │  │ + RLS       │  │  • /plan  (the agent) │    │
│  │            │  │ (tasks,     │  │  • /commute (maps)    │    │
│  │            │  │  routines,  │  │                       │    │
│  │            │  │  blocks…)   │  │  secrets:             │    │
│  │            │  │             │  │   OPENAI_API_KEY      │    │
│  │            │  │             │  │   MAPS_* keys         │    │
│  └────────────┘  └─────────────┘  └──────────┬───────────┘    │
└────────────────────────────────────────────────┼──────────────┘
                                                  │ server-side calls
                        ┌─────────────────────────┼──────────────────────┐
                        ▼                                                  ▼
              ┌───────────────────┐                          ┌───────────────────────┐
              │ AI provider        │                          │ Maps provider          │
              │ (PlannerLLM)       │                          │ (MapsProvider)         │
              │  default: OpenAI   │                          │  default: Apple Maps   │
              │  swappable: Claude │                          │  Google / Amap (later) │
              └───────────────────┘                          └───────────────────────┘
```

## Components

### iOS app (native SwiftUI)
- **Three screens** (see `PRODUCT_SPEC.md`): Chat, Timetable, Profile.
- **Speech → text** on-device (Speech framework) for the mic button.
- **MapKit** for *rendering* maps and live navigation only. Planning-time geocoding/ETA is
  computed server-side (see Maps below) so the model can reason with it in one round trip.
- Talks only to Supabase: the Postgres tables (via the Supabase Swift client, guarded by
  RLS) and the Edge Functions. **No OpenAI or maps keys live in the app.**

### Supabase
- **Auth** — email + Apple/Google sign-in (international-first). Issues the JWT the app
  sends on every request.
- **Postgres + Row-Level Security** — the source of truth for tasks, routines, time blocks,
  locations, conversations. Every table is scoped to `auth.uid()` by RLS so a user can only
  ever see their own rows. Schema in [`../supabase/schema.sql`](../supabase/schema.sql).
- **Edge Functions** — the trust boundary. Hold the OpenAI and maps keys; enforce the
  caller's JWT; make upstream calls.

### Edge Function: `/plan` (the planning agent)
The heart of the product. Receives a user message (+ conversation id), runs the
**agent loop** described in `AI_PLANNING.md`, and returns either a clarifying question
(for the app to render as a multiple-choice card) or a scheduling receipt. It:
1. Loads the user's routine, locations, and current schedule from Postgres.
2. Calls the `PlannerLLM` with the conversation + tools.
3. Fulfills tool calls (`geocode_place`, `estimate_commute`, `get_schedule`,
   `schedule_tasks`, `ask_user_questions`) — DB reads/writes and `MapsProvider` calls.
4. Persists messages and any created/updated blocks; returns the result.

### Edge Function: `/commute` (optional standalone)
A thin wrapper over `MapsProvider` for ad-hoc ETA lookups from the app (e.g., live "when
should I leave?"), separate from the agent loop.

## Data flow: a planning turn

1. User types/dictates a message in Chat → app `POST /plan { conversation_id, text }` with
   the Supabase JWT.
2. `/plan` authenticates the JWT, loads context (routine, schedule, locations), and runs
   the agent loop.
3. If the model needs clarification → `/plan` returns `{ type: "questions", questions:[…] }`
   → app renders a multiple-choice card (with "Other"). User answers → app `POST /plan`
   again with the answer; the loop resumes.
4. When the model finalizes → `/plan` writes the new/updated `time_blocks` (including
   commute blocks) to Postgres and returns `{ type: "scheduled", receipt, blocks }`.
5. App shows the receipt in Chat; the Timetable (reading the same Postgres tables, live via
   Supabase) reflects the new blocks.

## Provider abstractions

Two seams keep us un-locked-in and ready for China:

### `PlannerLLM` (AI)
```
interface PlannerLLM {
  // Drive one step of the agent loop: given messages + tool defs, return either
  // assistant text, tool calls to fulfill, or a final structured result.
  run(input: { system, messages, tools }): Promise<LLMStep>
}
```
- **OpenAICompatiblePlanner** (default) — OpenAI function calling; also drives **Qwen**
  (Alibaba DashScope, OpenAI-compatible) via a different `baseURL`.
- **AnthropicPlanner** — Anthropic tool use. Same contract.
- Selected by `ACTIVE_LLM_PROVIDER` in the Edge Function; adapters live in
  `server/llm/providers.ts`. See `AI_PROVIDERS.md`.

### `MapsProvider` (geocoding + ETA)
```
interface MapsProvider {
  geocode(query): Promise<{ name, address, lat, lng, placeId }>
  directions(from, to, modes): Promise<{ mode, durationMin, distanceM }[]>
}
```
- **AppleMapsProvider** (default) — Apple Maps Server API (token auth).
- **GoogleMapsProvider** — Google Maps Platform.
- **AmapProvider** (China, later) — 高德.

## Security model

- **Single secret on the client:** the user's Supabase session token. Nothing else.
- **All third-party keys** (OpenAI, maps) live in **Supabase secrets**, used only inside
  Edge Functions.
- **RLS everywhere:** every table enforces `user_id = auth.uid()`. Even if a query is
  malformed, a user cannot read another user's data.
- **Edge Functions authenticate** the caller's JWT and derive `user_id` server-side — they
  never trust a `user_id` sent by the client.
- Per-user rate limiting / quota lives in the Edge Function (protects the OpenAI bill).

## Analytics & the developer dashboard

Every model step emits a `UsageEvent` (provider, model, tokens, cost, latency — see
`server/usage.ts`) that the `/plan` function writes to `usage_events`; the app/Edge Functions
also log product actions to `app_events`. A **separate, admin-only web app** reads SQL
aggregation views (`metrics_*`) for DAU, action volume, token/cost trends, and an
OpenAI-vs-Anthropic-vs-Qwen comparison. Schema: `supabase/analytics.sql`; design:
`docs/DASHBOARD.md`. It's a separate deploy and platform-independent (no Mac).

## Why server-side for AI *and* maps

Running both inside `/plan` means a single planning turn — extract tasks → geocode →
compute commute → fit the schedule → write blocks — completes in one authenticated round
trip, with all secrets and all business logic on the server. The app stays thin: capture
input, render cards and the timetable.
