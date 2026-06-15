# Roadmap — to the App Store

Phased plan. Phase 0 (this branch) is platform-independent and done in the cloud; the rest
happens on macOS with Xcode. Each phase is shippable/testable on its own.

Legend: ✅ done · 🔜 next · ⬜ later

## Phase 0 — Foundation (no Mac needed) ✅
- ✅ Product spec, architecture, data model, AI planning + providers, dashboard design, decisions.
- ✅ Postgres schema + RLS (`supabase/schema.sql`) and analytics schema + dashboard views (`supabase/analytics.sql`).
- ✅ **Backend logic, unit-tested on Node** (`server/`): scheduling engine (incl. timezone-aware routine → availability windows), planner agent loop with the clarifying-question interrupt, multi-provider LLM (OpenAI/Anthropic/Qwen), usage accounting. **CI runs the tests on every push** (`.github/workflows/ci.yml`). Green: 23 server + 5 dashboard.
- Outcome: a clear blueprint, a runnable schema, and tested core logic ready to drop into the Edge Function.

## Phase 1 — Backend stands up ✅ (live on Supabase `piyfhwmrumbexofbjqyu`)
- ✅ Supabase project created; `schema.sql` + `analytics.sql` applied via migrations (`supabase db push`). Email auth on; Apple/Google providers later.
- ✅ Seed data applied via the admin/REST API (test user `test@planfect.dev` + routine + locations).
- ✅ `/plan` Edge Function **deployed** (JWT-gated): auth → load context → planner → usage logging. READ handlers wired; **schedule-WRITE handlers finished** (`planningWindowsForDate` + day busy + `scheduleTask` → insert `tasks` + `time_blocks` incl. commute/buffer). `index.ts` now splits a user-context client (RLS) from a service-role client (analytics).
- ✅ Verified against the LIVE DB with the real handler over a test-user JWT: writes commute + task blocks, links `task_id`, sets `status`, logs `app_events`.
- ✅ Runnable end-to-end demo (`server/demo/planDemo.ts`): mock model + the REAL scheduler shows ask → answer → commute → schedule → receipt.
- ✅ `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` secrets set; **full `/plan` LLM round-trip verified live** (OpenAI `gpt-4.1`): agent loop estimate_commute → get_schedule → schedule_tasks → receipt, AND the ask-clarifying-questions branch, with `usage_events` cost correctly priced (dated-snapshot ids fall back to the base price).

## Phase 2 — The planner brain 🔜 (real provider already wired & verified in Phase 1)
- ✅ Agent loop wired to a real provider via `createPlanner` (OpenAI `gpt-4.1` default; Anthropic/Qwen swappable by secret); `usage_events` persisted with correct cost.
- ✅ `ask_user_questions` interrupt returns multiple-choice cards over the live API (verified). 🔜 Persist conversation/messages so the resume (answers → schedule) survives without the client replaying `messages`.
- ⬜ System prompt + duration heuristics; prompt caching on the stable prefix; fix receipt local-time rendering (model occasionally mis-states UTC→local in the prose).
- Outcome: send a free-text message → get clarifying questions and/or a scheduling receipt.

## Phase 3 — iOS app shell (SwiftUI) ✅ (running in the simulator)
- ✅ XcodeGen project (`ios/`) + Supabase Swift client; email/password auth (Sign in with Apple deferred to Phase 7 — needs the paid account).
- ✅ Two main tabs wired to live data — Chat + Timetable (day/week/month) — plus a Profile sheet via the top-right avatar.
- ✅ First-run onboarding writes the work/sleep routine and sets the profile timezone. (Full routine editor in Profile is read-only for now — next.)
- Note: PostgREST reads/writes go over URLSession with the session JWT (the SDK's `client.from` didn't reliably attach the token right after sign-in); `/plan` uses the SDK Functions client.
- Outcome: a logged-in user sees their schedule and the planner writes to it. **Verified live end-to-end in the simulator.**

## Phase 4 — Chat + voice + cards 🔜 (mostly done)
- ✅ Chat UI calling `/plan`; renders multiple-choice clarifying cards (+ "Other") and scheduling receipts (local-time formatted).
- ✅ Mic button + on-device Speech-to-text (`SpeechRecognizer`) feeding the same `/plan` path.
- 🔜 Receipt tap-through to the affected day; persist the conversation across the ask→answer round trip (currently the client replays `messages`).
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
