# Planfect

**An AI day planner.** Tell it — by voice or text — what you need to do and when, and it
works out the rest: it estimates how long each task takes, learns your daily routine
(work, commute, sleep, meals), schedules tasks into your free time, and pre-computes
travel time and mode for anything happening somewhere else.

Two main surfaces:

1. **Chat** — talk to the planning assistant in natural language ("dentist Friday, then
   groceries, and finish the report this week"). When it's unsure, it asks a quick
   **multiple-choice question with an "Other" free-text option** (the same UX as Claude's
   clarifying questions), then confirms exactly what it scheduled.
2. **Timetable** — your scheduled day / week.

Plus a **profile** screen (tap the avatar, top-right) for account info, your routine, and
settings.

**Goal:** ship to the App Store.

---

## Status

🟡 **Greenfield / foundation.** This branch contains the platform-independent design docs
and the database schema. None of it depends on a Mac, so it can move forward while the
native app work waits for a local macOS environment. App implementation (native iOS) is
the next phase.

## Tech stack

Rationale for every choice is recorded in [`docs/DECISIONS.md`](docs/DECISIONS.md).

| Layer | Choice |
|---|---|
| iOS app | **Native SwiftUI** (iOS-first; Android later reuses the backend, not the UI) |
| Backend | **Supabase** — Postgres + Auth + Storage + Edge Functions |
| AI | **OpenAI GPT** via a server-side Edge Function — provider-agnostic, Claude swappable |
| Maps / commute | Server-side **maps provider** behind an abstraction (Apple Maps Server API default; Google; Amap for China later) |
| Market | **International first** (Apple Maps + Google Maps, English UI), China later |

## Why this shape

- The AI key and the maps key **never ship in the app** — all model and maps calls go
  through Supabase Edge Functions. This is the single most important security decision.
- The **backend, data model, AI logic, and scheduling/commute logic are all
  platform-independent** — a future Android app reuses them and only re-implements the UI.
- The AI and maps providers are both **abstractions**, so switching OpenAI ↔ Claude, or
  Apple Maps ↔ Google ↔ Amap, is a config change, not a rewrite.

## Repo layout

```
planfect/
├── README.md
├── docs/
│   ├── PRODUCT_SPEC.md     # Features, the three screens, user stories
│   ├── ARCHITECTURE.md     # System design, data flow, security, provider abstractions
│   ├── DATA_MODEL.md       # Entities, relationships, schema walkthrough
│   ├── AI_PLANNING.md      # The conversational planner: agent loop, clarifying-question
│   │                       #   pattern (GPT function calling / structured outputs), prompts
│   ├── ROADMAP.md          # Phased plan to App Store; what's done / next
│   └── DECISIONS.md        # ADR log capturing the key decisions and their rationale
└── supabase/
    └── schema.sql          # Initial Postgres schema + Row-Level Security policies
```

## Docs index

- **Start here:** [`docs/PRODUCT_SPEC.md`](docs/PRODUCT_SPEC.md)
- **How it fits together:** [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)
- **The data:** [`docs/DATA_MODEL.md`](docs/DATA_MODEL.md) + [`supabase/schema.sql`](supabase/schema.sql)
- **The AI brain:** [`docs/AI_PLANNING.md`](docs/AI_PLANNING.md)
- **The plan to ship:** [`docs/ROADMAP.md`](docs/ROADMAP.md)
- **Why we chose what we chose:** [`docs/DECISIONS.md`](docs/DECISIONS.md)

## Next steps (when on macOS)

1. Create the Supabase project, apply `supabase/schema.sql`, enable Auth.
2. Scaffold the SwiftUI app (Xcode) with the three screens.
3. Build the planner Edge Function (OpenAI function-calling loop from `docs/AI_PLANNING.md`).
4. Wire the iOS app to Supabase + the Edge Function.

See [`docs/ROADMAP.md`](docs/ROADMAP.md) for the full phased plan.
