# Architecture Decision Record (ADR) Log

This file captures the foundational decisions for Planfect and **why** they were made, so
the reasoning isn't lost. Newest decisions are appended at the bottom.

Format: each decision has Context, Decision, Rationale, and Consequences.

---

## ADR-001 — Native SwiftUI for the iOS app

**Context.** The product is iOS-first with the App Store as the top priority; Android is a
"maybe later." A macOS machine with Xcode is available for development.

**Decision.** Build the app as **native SwiftUI**.

**Rationale.**
- The strongest fit for the stated priorities: best native feel, smoothest App Store
  review path, and first-class access to the exact APIs this product needs —
  **MapKit** (maps + commute ETAs), **Speech** (voice capture), **EventKit** (system
  calendar), **UserNotifications**, **WidgetKit**, **Live Activities**.
- The only reason we'd previously have leaned cross-platform (Expo, to build iOS without a
  Mac) is moot now that a Mac is available.

**Consequences.**
- Android, if pursued later, needs a separate UI implementation.
- **Mitigation:** the backend, data model, AI logic, and scheduling/commute logic are all
  platform-independent (ADR-003/004/006), so a future Android app reuses the whole system
  and only rebuilds the UI layer — not a from-scratch rewrite.

---

## ADR-002 — International market first

**Context.** The product could target international users (Apple/Google Maps, OpenAI/Claude
reachable, English) or China (Amap, WeChat login, ICP filing, in-country AI). Doing both
from day one is more work.

**Decision.** **International first.** Design China-specific pieces (Amap, phone/WeChat
login, ICP compliance) as later additions behind the same abstractions.

**Rationale.** Smoothest path for AI access and App Store submission; lets us validate the
core experience before taking on China-specific compliance and infra.

**Consequences.** UI is English-first (add localization later). Maps and AI provider
abstractions (ADR-004/006) are designed so the China swap is config + an adapter, not a
rewrite.

---

## ADR-003 — Supabase as the backend

**Context.** We need accounts, cross-device sync, persistent storage of tasks/routines/
schedule, and a secure place to run AI and maps calls. Candidates: Supabase, Firebase,
CloudKit, custom backend.

**Decision.** **Supabase** (Postgres + Auth + Storage + Edge Functions).

**Rationale.**
- **Relational data fits a scheduler.** Tasks, time blocks, routines, recurrence rules,
  locations, and commute segments are inherently relational and time-ranged. Postgres
  handles "find free slots", "detect overlaps", and "expand recurrence" far more naturally
  than Firestore's NoSQL model.
- Production-grade, with a clean Swift client, Row-Level Security for multi-tenant safety,
  and **Edge Functions** to proxy AI/maps calls server-side (keys never in the app).
- **Not Apple-locked** — a future Android app uses the same backend (supports ADR-001's
  mitigation).

**Alternatives considered.**
- *Firebase* — battle-tested and great real-time, but Firestore's NoSQL model is awkward
  for relational/temporal scheduling queries; vendor lock-in.
- *CloudKit* — free and privacy-friendly, but Apple-only (kills Android reuse) and still
  needs a separate service for AI calls.
- *Custom backend* — maximum control, highest build/ops cost; not worth it at this stage.

**Consequences.** We own a bit more configuration than a fully-managed BaaS. Multi-user
safety depends on correct Row-Level Security policies (encoded in `supabase/schema.sql`).

---

## ADR-004 — OpenAI GPT as the default AI provider, behind a provider abstraction

**Context.** The planner needs an LLM that can converse, extract structured tasks from
free text, ask clarifying questions, and reason about scheduling/commute. The developer has
existing OpenAI credit.

**Decision.** Default to **OpenAI GPT**, called **only from the server-side Edge Function**,
behind a **provider-agnostic `PlannerLLM` interface** so Claude (or others) can be swapped
or A/B-tested without touching app or scheduling code.

**Rationale.**
- Uses available OpenAI credit; GPT has mature **function calling + Structured Outputs**,
  which is exactly the mechanism for the multiple-choice clarifying questions
  (see `docs/AI_PLANNING.md`).
- The abstraction costs little now and prevents lock-in: because the LLM lives behind one
  Edge Function interface, switching providers is an adapter change.

**Consequences.** All providers must be driven through the same tool/loop contract. The
OpenAI API key lives in Supabase secrets, never in the client.

---

## ADR-005 — All AI and maps calls go through a server-side proxy

**Context.** Mobile apps can be decompiled; any secret shipped in the binary is
compromised. The app needs to use paid AI and maps APIs.

**Decision.** The iOS app **never** calls OpenAI or a maps provider directly. It calls
**Supabase Edge Functions**, which hold the secrets and make the upstream calls.

**Rationale.** Keeps API keys server-side; lets us add rate limiting, per-user quotas,
caching, and provider switching centrally; the only secret the app holds is the user's own
Supabase session token.

**Consequences.** One extra network hop (negligible). The Edge Functions are the trust
boundary and must enforce auth (the caller's Supabase JWT) on every request.

---

## ADR-006 — Maps/commute behind a `MapsProvider` abstraction (Apple Maps Server API default)

**Context.** The planner must geocode places and compute commute time + mode between
locations. It needs this **server-side** (inside the agent loop in the Edge Function), and
the market is international-first with a China expansion later.

**Decision.** Define a **`MapsProvider`** interface (geocode, directions/ETA). Default
implementation: **Apple Maps Server API**. Alternatives: Google Maps Platform; **Amap
(高德)** for China later.

**Rationale.** Keeping geocoding/ETA server-side lets the whole planning turn complete in
one round trip. Apple Maps Server API fits the Apple ecosystem and international focus;
the abstraction makes Google/Amap drop-in.

**Consequences.** The iOS app still uses on-device **MapKit** for *rendering* maps and live
navigation, but *planning-time* geocoding/ETA is computed server-side via the chosen
`MapsProvider` so the model can reason with it. See `docs/ARCHITECTURE.md` → Maps.
