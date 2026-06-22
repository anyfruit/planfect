# Planfect

[![CI](https://github.com/anyfruit/planfect/actions/workflows/ci.yml/badge.svg)](https://github.com/anyfruit/planfect/actions/workflows/ci.yml)
&nbsp;·&nbsp; iOS 17+ · SwiftUI · Supabase · Deno/TypeScript · OpenAI · Google Maps · EN / 中文

**An AI day planner you talk to.** Tell it your plans — by text or voice, one line or a whole
afternoon at once — and it builds your day around your routine, commute, and habits: it picks
sensible times, adds **real travel time so you arrive on time**, **looks up real event times on the
web**, learns your preferences, flags conflicts, reminds you, and shows what's next on a
home-screen widget.

▶︎ **[Try the live demo — no install needed →](https://planfect-support-production.up.railway.app/showcase)**
It runs the *real* planner (real web lookups, real Google Maps travel times, real timezone-aware
scheduling) — type a plan and watch it schedule.

---

## Status

✅ **Built and submitted to the App Store** (in review; release in progress).

- **Backend — live** on Supabase (project `piyfhwmrumbexofbjqyu`): full schema + Row-Level Security
  and three Deno Edge Functions (`plan`, `plan-demo`, `insights`).
- **iOS app — built:** a complete native SwiftUI client — chat planner, day/week/month timetable,
  insights charts, profile, and an offline onboarding — with a **WidgetKit** home/lock-screen widget,
  **Sign in with Apple**, **Apple Calendar** sync, local notifications, voice input, and `.ics`/`.json`
  export. Archived and uploaded to App Store Connect (v1.0).
- **Live on the web:** a public, no-account demo of the real planner, a support page, and a bilingual
  case-study page (all on Railway), plus a password-gated **analytics dashboard** (Next.js) for
  usage / cost / model metrics.
- **Tested:** the platform-independent backend logic (`server/`) is unit-tested — **29 tests**, no
  network or keys required — and CI runs the suite on every push.

> Planfect Pro / billing is a **dormant skeleton** (see [Security & billing](#security--billing)) —
> everything is currently free.

## What it does

Four surfaces in the app:

- **Chat** — talk to the planner in natural language (*"dentist Friday 3pm, groceries, finish the
  report this week"*, or a voice brain-dump of a whole day). When a detail is genuinely ambiguous it
  asks a quick **multiple-choice question with an "Other" free-text option**, then confirms exactly
  what it scheduled in a **tap-to-edit receipt**.
- **Schedule** — your day as a list, your week as a timeline grid, your month as a calendar; tap any
  block to edit, complete, or reschedule.
- **Insights** — where your time goes by category (donut + per-day bars via Swift Charts), with an
  optional **AI read** of your week.
- **Profile** — routine (work / sleep / meals), Home/Work places, recurring habits, learned
  preferences, reminders, calendar sync, export, timezone.

…plus a **home / lock-screen widget** that shows what's next and advances itself at task boundaries.

Under the hood the planner:

- schedules tasks into your **free time around a soft routine** (work, sleep, meals), in your timezone;
- adds **real travel time** (Google Maps) and places the commute **before** a fixed event — you leave
  early and arrive on time, not the activity pushed later;
- **looks up real event times on the web** (a match, a showtime, store hours) and schedules around the
  actual time, converting timezones when the event is elsewhere;
- **learns durable preferences** and sets up **recurring habits** that auto-fill weeks ahead;
- handles a **multi-task brain-dump in one shot**, and only asks when it's genuinely unsure.

## Architecture

```
   iOS app  (SwiftUI · WidgetKit · EventKit · Swift Charts)
       │  HTTPS, user JWT (anon key only — RLS-guarded)
       ▼
   Supabase Edge Functions  (Deno / TypeScript)
     • /plan        the planner agent           (JWT-gated)
     • /plan-demo   same planner, public,        (no auth, writes nothing → powers the live demo)
     • /insights    AI time analysis             (JWT-gated)
       │
   ┌───┴───────────────┬──────────────────────────┐
   ▼                   ▼                          ▼
 OpenAI            Google Maps               Postgres + RLS
 (LLM tool-call    (Routes + Geocoding)      tasks · time_blocks · routines ·
  + web search)                              preferences · recurring_tasks · locations · …
```

- **The AI key and the maps key never ship in the app.** Every model/maps call goes through an Edge
  Function; the app holds only the RLS-guarded anon key. This is the single most important security
  decision.
- **The scheduling + agent logic is platform-independent** (`server/`, pure TypeScript, unit-tested on
  Node) and runs verbatim inside the Deno Edge Functions — a future Android app reuses it and only
  re-implements the UI.
- **Providers are abstractions:** the LLM sits behind one `PlannerLLM` interface (OpenAI / Anthropic /
  Qwen / MiniMax — switch via config), and maps behind a `MapsProvider` interface.

## The planner agent

[`server/planner.ts`](server/planner.ts) is a provider-agnostic **tool-calling loop**: it calls the
model, the model calls server-side tools, and it returns one of three results — a **scheduled
receipt**, a set of **clarifying questions** (the loop short-circuits, hands tappable cards back to the
app, then resumes with the answer), or a plain **message**. The tools:

| Tool | What it does |
|---|---|
| `schedule_tasks` | Place one or many tasks around routine + existing blocks; create the task and its time-blocks (with commute & buffer). The main write. |
| `ask_user_questions` | Ask 1–3 multiple-choice questions when a detail is genuinely ambiguous (rendered as cards + an "Other" free-text option). |
| `estimate_commute` | Real travel time / mode between two places (Google Routes); inserted **before** the task. |
| `geocode_place` | Resolve a place to coordinates + address (Google Geocoding). |
| `web_search` | Look up a real, time-sensitive fact (event / show / broadcast time, store hours). |
| `get_schedule` | Read existing blocks to find free slots and avoid conflicts. |
| `set_routine` | Add / update / delete a background routine (work / sleep / meal / commute). |
| `set_recurring` | Create / delete a repeating habit (e.g. gym Mon/Wed/Fri 7am); auto-placed weeks ahead. |
| `remember_preference` | Persist a durable planning preference across conversations. |
| `update_task` | Move / resize / complete / delete an existing scheduled task. |

The pure placement engine ([`server/scheduling/`](server/scheduling)) is **timezone- and DST-aware**
and unit-tested, including the "leave early, arrive on time" commute logic. Full write-up in
[`docs/AI_PLANNING.md`](docs/AI_PLANNING.md).

## Tech stack

| Layer | Choice |
|---|---|
| iOS app | Native **SwiftUI** (iOS 17+), **WidgetKit**, **EventKit**, **Swift Charts**, Sign in with Apple, Speech; project generated with **XcodeGen** |
| Backend | **Supabase** — Postgres + Auth + **Edge Functions** (Deno / TypeScript) |
| Data | Postgres with **Row-Level Security** — each user can only ever read/write their own rows |
| AI | **OpenAI** by default behind a `PlannerLLM` abstraction (Anthropic / Qwen / MiniMax drop in via config); LLM tool-calling + web search |
| Maps | **Google Maps** — Routes + Geocoding, server-side, behind a `MapsProvider` abstraction |
| Aux services | A **Next.js** admin dashboard + a zero-dependency **Node** support / showcase site, both on **Railway** |
| Quality | Node's built-in test runner (zero deps), CI on every push; fully bilingual (English / 简体中文) |

Rationale for each choice is recorded in [`docs/DECISIONS.md`](docs/DECISIONS.md).

## Security & billing

- **No secret ever lives in the repo.** Provider and service-role keys are **Supabase secrets**, read
  from `Deno.env` inside Edge Functions only; the iOS app ships just the anon key (RLS-guarded). See
  [`.env.example`](.env.example).
- **RLS everywhere** — every user-data table has an owner-only policy; analytics tables are written by
  the service role and readable only by admins.
- **The public demo** (`/plan-demo`) runs the real planner but **writes nothing** and reads no real
  user's data; it's rate-limited per IP (and the showcase caps turns per device).
- **Billing is dormant** — a freemium skeleton exists (`BILLING_ENFORCED` gate,
  `FREE_MONTHLY_AI_UNITS`, `profiles.is_pro`) but is switched off; no StoreKit / RevenueCat purchase
  flow is wired yet.

## Repo layout

```
planfect/
├── server/                   # Platform-independent backend logic (TypeScript, unit-tested on Node)
│   ├── scheduling/           #   timezone-aware free-slot + placement engine (routines, commute-before)
│   ├── llm/                  #   PlannerLLM contract, the 10 planner tools, provider adapters, mock
│   ├── maps/                 #   MapsProvider interface
│   ├── planner.ts            #   the agent tool-calling loop
│   ├── usage.ts              #   usage events + cost estimation (dashboard data)
│   └── demo/planDemo.ts      #   runnable end-to-end demo (Node, no keys)
├── supabase/
│   ├── schema.sql            # App schema + Row-Level Security
│   ├── analytics.sql         # usage_events / app_events + dashboard views
│   ├── migrations/           # ordered schema history (category, preferences, recurring_tasks, is_pro)
│   └── functions/
│       ├── plan/             #   the planner Edge Function (wires server/ → Supabase + OpenAI + Google Maps)
│       ├── plan-demo/        #   public, no-auth, no-DB demo of the planner
│       └── insights/         #   AI time-analysis
├── ios/
│   ├── Planfect/             # SwiftUI app (Chat · Schedule · Insights · Profile · Onboarding · Services)
│   ├── PlanfectWidget/       # WidgetKit home/lock-screen widget (shares an App Group with the app)
│   └── project.yml           # XcodeGen project spec
├── dashboard/                # Next.js admin dashboard (usage / cost / model comparison) — Basic-Auth gated
├── support-site/             # Zero-dep Node site: /support, /privacy, /showcase (+ the live demo)
├── docs/                     # Design docs + ADRs (see index below)
└── .github/workflows/ci.yml  # Runs the server + dashboard tests on every push
```

## Run it

**Backend logic — no Mac, no keys, no Supabase:**

```bash
npm test                                                  # 29 unit tests (Node ≥ 22, built-in runner)
node --experimental-strip-types server/demo/planDemo.ts   # end-to-end planner demo (mock LLM + maps)
```

**iOS app — macOS + Xcode:**

```bash
cd ios && xcodegen generate          # generate Planfect.xcodeproj from project.yml
# open Planfect.xcodeproj and run on an iPhone simulator — no signing identity needed for the sim
```

**Edge Functions — Supabase CLI:**

```bash
supabase functions deploy plan       --project-ref <ref>
supabase functions deploy plan-demo  --no-verify-jwt --project-ref <ref>   # public endpoint
supabase functions deploy insights   --project-ref <ref>
```

## Docs

`docs/` holds the design record (intent + decisions). The product has since moved past several of
these documents — this README and the [live showcase](https://planfect-support-production.up.railway.app/showcase)
reflect the current state.

- **Start here:** [PRODUCT_SPEC.md](docs/PRODUCT_SPEC.md) &nbsp;·&nbsp; **How it fits together:** [ARCHITECTURE.md](docs/ARCHITECTURE.md)
- **The data:** [DATA_MODEL.md](docs/DATA_MODEL.md) + [schema.sql](supabase/schema.sql)
- **The AI brain:** [AI_PLANNING.md](docs/AI_PLANNING.md) &nbsp;·&nbsp; [AI_PROVIDERS.md](docs/AI_PROVIDERS.md)
- **Dashboard:** [DASHBOARD.md](docs/DASHBOARD.md) &nbsp;·&nbsp; **Deploy (Railway):** [railway-deploy.md](docs/railway-deploy.md)
- **App Store copy:** [app-store-listing.md](docs/app-store-listing.md) &nbsp;·&nbsp; **Decisions (ADRs):** [DECISIONS.md](docs/DECISIONS.md)
- **中文:** [项目进度](docs/PROJECT_STATUS.zh.md) &nbsp;·&nbsp; [上手 / 继续指南](docs/SETUP.zh.md)

## Recent updates

_2026-06-21_

- **Commute shows the real travel mode.** The receipt no longer always reads "transit" with a walking
  icon — `estimate_commute` and `schedule_tasks` now thread the actual mode (e.g. driving for an
  airport run) into the commute block and the receipt's label + glyph.
- **Tentative holds for undecided details.** When you clearly mean to do something but a detail is
  still open (*"fine dining on the 28th, haven't picked where"*), the planner blocks a tentative slot
  to refine later — instead of asking which place or scheduling nothing.
- **No more chat freeze.** Sending a new message (or answering late) while a question card was still
  pending left a malformed tool-call thread the model rejects, which could brick the conversation; the
  backend now repairs the thread and the UI locks a superseded card.
- **MiniMax (M3) wired as a provider.** Added `minimax` to the pluggable LLM layer — OpenAI-compatible,
  so it reuses the existing adapter — as a domestic-China option. M3 is a reasoning model (its `<think>`
  chain-of-thought is stripped), roughly 7× cheaper per token than the GPT-4.1 tier, and validated
  end-to-end (chat + tool-calling). Flip via `ACTIVE_LLM_PROVIDER=minimax` + `PLANNER_MODEL=MiniMax-M3`.
- **Dashboard → control panel.** The developer dashboard gains a per-surface **model switcher** (app
  vs demo): pick `gpt` / `claude` / `MiniMax` from a dropdown and the live planner switches within
  ~20s, **no redeploy** — backed by a new `runtime_config` table the edge functions read (falling back
  to OpenAI if the chosen provider's key isn't configured).
- **Explicit times schedule directly.** An explicitly-stated clock time with no day (e.g. "下午3点开会")
  now lands on the obvious day (today, or tomorrow if it already passed) with a one-line confirm,
  instead of an unnecessary yes/no question.
- **Prompt-eval harness.** [`server/eval/promptEval.ts`](server/eval/promptEval.ts) drives the real
  planner over a fixed scenario suite (deterministic pinned clock) and scores each result against an
  expected behavior — so prompt changes are *measured* (pass-rate per model) instead of eyeballed.
  Runs against any provider via `EVAL_PROVIDER`/`EVAL_MODEL`.
- **Day-parts schedule directly (prompt).** A bare day-part with no day (e.g. "下午健身" late at night)
  now lands on the soonest valid day as a tap-to-edit receipt instead of a yes/no question — a gap the
  harness caught across every model. The suite is now **22 scenarios** (incl. adversarial: a boundary
  guardrail, past-time, relative dates); `gpt-5.1-chat` passes **22/22**.
- **Build 3 → TestFlight.** v1.0 (build 3) uploaded to App Store Connect carrying the commute-icon +
  chat-freeze iOS fixes (the prompt/commute-mode backend changes were already live on the Edge Functions).
  Repeatable now via [`ios/deploy-testflight.sh`](ios/deploy-testflight.sh) — bumps the build, archives,
  re-signs with an ASC-API-managed distribution cert + profiles (no Xcode GUI, no cloud signing), uploads.

## Author & license

Designed and built end-to-end by **Kejing Yan (闫可菁)** — [LinkedIn](https://linkedin.com/in/kejing-yan)
· [GitHub](https://github.com/anyfruit).

© 2026 Kejing Yan. **All rights reserved** — this repository is published for portfolio and
demonstration purposes only and is **not** open source. See [LICENSE](LICENSE).
