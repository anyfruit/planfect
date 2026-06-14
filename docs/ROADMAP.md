# Roadmap — to the App Store

Phased plan. Phase 0 (this branch) is platform-independent and done in the cloud; the rest
happens on macOS with Xcode. Each phase is shippable/testable on its own.

Legend: ✅ done · 🔜 next · ⬜ later

## Phase 0 — Foundation (no Mac needed) ✅
- ✅ Product spec, architecture, data model, AI planning + providers, dashboard design, decisions.
- ✅ Postgres schema + RLS (`supabase/schema.sql`) and analytics schema + dashboard views (`supabase/analytics.sql`).
- ✅ **Backend logic, unit-tested on Node** (`server/`): scheduling engine, planner agent loop with the clarifying-question interrupt, multi-provider LLM layer (OpenAI/Anthropic/Qwen), usage accounting. `npm test` green (18 tests).
- Outcome: a clear blueprint, a runnable schema, and tested core logic ready to drop into the Edge Function.

## Phase 1 — Backend stands up (mostly Mac, some cloud) 🔜
- ⬜ Create the Supabase project; apply `schema.sql` + `analytics.sql`; enable Auth (email + Apple/Google).
- 🔜 Seed data written (`supabase/seed.sql`: sample user / routine / locations) — apply after creating the auth user.
- 🔜 `/plan` Edge Function scaffold written (`supabase/functions/plan/`): auth → load context → planner → usage logging. READ handlers wired; schedule-WRITE handlers have TODOs to finish against the live schema.
- ✅ Runnable end-to-end demo (`server/demo/planDemo.ts`): mock model + the REAL scheduler shows ask → answer → commute → schedule → receipt.
- Outcome: deploy the function with real keys + finish the write handlers → tasks → time_blocks via an authenticated call.

## Phase 2 — The planner brain 🔜
- ⬜ Wire the agent loop (`server/planner.ts`, done) to a real provider via `createPlanner`
  (OpenAI default; Anthropic/Qwen swappable) and persist `usage_events`.
- ⬜ `ask_user_questions` interrupt flow (return questions → resume with answers) — logic done, wire to the API.
- ⬜ System prompt + duration heuristics; prompt caching on the stable prefix.
- Outcome: send a free-text message → get clarifying questions and/or a scheduling receipt.

## Phase 3 — iOS app shell (SwiftUI) 🔜
- ⬜ Xcode project; Supabase Swift client; auth flow (Sign in with Apple).
- ⬜ Three screens wired to data: Chat, Timetable (day/week), Profile.
- ⬜ Profile → Routine editor (work/sleep/meals/commute).
- Outcome: a logged-in user can see their schedule and edit their routine.

## Phase 4 — Chat + voice + cards ⬜
- ⬜ Chat UI calling `/plan`; render the multiple-choice clarifying cards (+ "Other").
- ⬜ Mic button → on-device Speech-to-text → same `/plan` path.
- ⬜ Receipts in the thread, tap-through to the affected day.
- Outcome: the core loop — talk/dictate → questions → scheduled — works in the app.

## Phase 5 — Maps & commute ⬜
- ⬜ `MapsProvider` (Apple Maps Server API) behind `geocode_place` / `estimate_commute`.
- ⬜ Commute blocks + buffers inserted automatically; "leave by" surfaced.
- ⬜ MapKit rendering in block details.
- Outcome: location-based tasks get realistic travel time and mode.

## Phase 6 — Polish & notifications ⬜
- ⬜ Local notifications ("leave in 15 min", "focus block starting").
- ⬜ Conflict/overflow handling; reschedule via the assistant.
- ⬜ Empty states, error states, onboarding for first-run routine setup.
- ⬜ Optional: WidgetKit (today at a glance), Live Activity for the next block.

## Phase 7 — App Store ⬜
- ⬜ Apple Developer account; bundle id, capabilities (Speech, Sign in with Apple, push).
- ⬜ Privacy: data-use disclosures (mic, location, AI processing), privacy policy.
- ⬜ App icon, screenshots, description; TestFlight beta.
- ⬜ Submit for review.

## Phase 8 — Developer dashboard 🔜
- 🔜 Admin web app **scaffold written** (`dashboard/`, Next.js): KPI cards + model-comparison +
  daily-usage tables reading the `metrics_*` views; pure helpers unit-tested.
- ⬜ Persist `usage_events` (from the planner) and `app_events` (key actions) — wire the sinks
  in Phase 1/2 so data accrues early.
- ⬜ Seed an `admins` row; deploy the dashboard (separate, behind access control).
- ⬜ Add charts (recharts/visx), admin-login (replace the service-role read), and an
  action-breakdown panel.
- Outcome: real visibility into users, usage, spend, and OpenAI-vs-Anthropic-vs-Qwen. (Mac-free.)

## Later / post-v1 ⬜
- ⬜ EventKit two-way sync with the system calendar.
- ⬜ China market: Amap provider, phone/WeChat login, ICP compliance.
- ⬜ Android (reuses backend + AI + scheduling; new UI only).
- ⬜ Recurring tasks (`rrule`), smarter routine inference from chat, A/B GPT vs Claude.

---

### Immediate next actions (when you're on your Mac)
1. `git clone` this repo.
2. Create the Supabase project and apply `supabase/schema.sql`.
3. Tell me to start **Phase 1** (Edge Function skeleton + scheduling writes) — it's the
   highest-value next step and is independently testable.
