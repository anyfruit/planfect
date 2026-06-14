# server/ — Planfect backend logic

Pure, runtime-agnostic TypeScript: the scheduling engine, the planner agent loop, the
multi-provider LLM layer, and usage accounting. It deploys as **Supabase Edge Functions
(Deno)**, but the logic has no Deno-specific dependencies, so it's developed and unit-tested
on **Node** here (no Mac, no Supabase, no API keys needed for the tests).

## Layout

```
server/
├── types.ts                 # domain types (Question, Receipt, enums)
├── scheduling/
│   ├── freeSlots.ts         # pure interval math (merge/subtract/free/find/sessions)
│   └── scheduler.ts         # place a task (+commute/buffer, or multi-session)
├── llm/
│   ├── types.ts             # PlannerLLM contract, messages, tools, usage
│   ├── tools.ts             # provider-neutral tool defs (incl. ask_user_questions)
│   ├── providers.ts         # adapters: OpenAI/Qwen (OpenAI-compatible) + Anthropic
│   └── mock.ts              # MockPlanner (scripted, for tests/dev)
├── maps/
│   └── types.ts             # MapsProvider interface + MockMapsProvider
├── usage.ts                 # UsageEvent, pricing table, cost estimate (dashboard data)
└── planner.ts               # the agent loop (tool calls + clarifying-question interrupt)
```

## Run the tests

Requires Node ≥ 22 (uses built-in type stripping + test runner — no build step, no deps):

```bash
npm test
# or directly:
node --experimental-strip-types --test "server/**/*.test.ts"
```

Covered by tests (all pure, no network):
- the scheduling engine (free slots, placement, commute insertion, multi-session, deadlines),
- the planner loop end-to-end via `MockPlanner` (clarifying-question interrupt → resume →
  schedule → receipt), incl. usage accounting,
- cost estimation across providers/models.

The network provider adapters (`llm/providers.ts`) are scaffolds — integration-test with
real keys before relying on them.

## Notes for the Edge Function (later)

- Read `ACTIVE_LLM_PROVIDER` / `PLANNER_MODEL` + keys from env (`.env.example`); call
  `createPlanner(provider, { apiKey })`.
- Inject DB-backed `ToolHandlers` (geocode/commute via `MapsProvider`, get/schedule via
  Postgres) and a Supabase-backed `UsageSink` that writes `usage_events`.
- Keep the system prompt's stable prefix (routine/preferences) cache-friendly.
