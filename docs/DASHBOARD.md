# Developer Dashboard

A **separate** admin/developer web app (not the user-facing iOS app) for monitoring the
product and the AI spend: user counts, action volume, token usage, cost, and model/provider
comparison. It reads the analytics tables and views; it is **admin-only**.

## What it shows

**Product**
- Total users; **DAU / WAU / MAU** (active users over time).
- Action volume and breakdown: messages sent, voice notes, questions answered, tasks
  scheduled, reschedules — from `app_events`.
- Funnels later (e.g. message → questions → scheduled).

**AI usage & cost**
- Tokens (input / output / cached) over time, by provider & model.
- **Cost (USD)** over time and per model.
- **Model comparison panel** — calls, total tokens, cost, avg latency, error rate per
  `provider:model`. This is how OpenAI vs Anthropic vs Qwen is evaluated with real data.
- Latency and error-rate trends; slow/failed calls.

## Data sources

Defined in [`../supabase/analytics.sql`](../supabase/analytics.sql):

| Object | Purpose |
|---|---|
| `usage_events` | one row per LLM call (provider, model, tokens, cost, latency, success) — emitted by the planner (`server/usage.ts`) |
| `app_events` | product actions (type + metadata) for counts / active users |
| `admins` + `is_admin()` | gates who can read analytics |
| `metrics_usage_daily` | daily tokens + cost by provider/model |
| `metrics_model_comparison` | all-time model/provider comparison |
| `metrics_dau` | daily active users + actions |
| `metrics_actions_daily` | action counts by type per day |

The views use `security_invoker`, so they honor the admin-only RLS on the base tables — a
non-admin querying a view gets nothing.

## Access model

- Analytics tables are **written by the Edge Functions** using the Supabase **service role**
  (bypasses RLS); they are **never** written from the app.
- **Reads** require membership in `admins`. The dashboard signs in as a Supabase user who is
  an admin, or runs on a small secured backend using the service role.
- No analytics are exposed to normal users.

## Tech (planned, separate deploy)

- A standalone web app — **Next.js / React + a charts library** (e.g. Recharts/visx) on the
  Supabase JS client (or a thin server using the service role).
- Deployed independently from the user app (e.g. Vercel/Netlify). **Platform-independent /
  Mac-free** — it can be scaffolded in the cloud whenever we choose.

## Why it works from day one

The data accrues before the dashboard UI exists:
- The planner **already emits** `UsageEvent` per model step (`server/usage.ts`,
  unit-tested). Phase 1/2 just persists those to `usage_events`.
- The app/Edge Function logs `app_events` for key actions.

So by the time we build the dashboard, there's real history to render. Build order is in
[`ROADMAP.md`](ROADMAP.md).
