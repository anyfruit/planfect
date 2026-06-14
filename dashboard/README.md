# dashboard/ — Planfect developer/admin dashboard

A **separate** web app (Next.js, App Router) showing usage, cost, and model comparison —
**not** the user-facing iOS app. It reads the analytics views from `supabase/analytics.sql`.
Platform-independent (no Mac); deploy separately from the app (e.g. Vercel/Netlify).

## What it shows (v0)

- KPI cards: model calls, tokens, spend, peak daily active users, actions (30d).
- **Model comparison** table — calls, tokens, cost, avg latency, error rate per
  `provider:model` (how OpenAI vs Anthropic vs Qwen compare on real data).
- Daily usage table.

## Run

```bash
cd dashboard
cp .env.local.example .env.local   # fill SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (server-side)
npm install
npm run dev                        # http://localhost:3000
```

Pure helpers are unit-tested without installing anything (Node ≥ 22):

```bash
npm test    # node --experimental-strip-types --test "lib/**/*.test.ts"
```

## Structure

```
dashboard/
├── app/
│   ├── layout.tsx
│   └── page.tsx            # server component: KPIs + model comparison + daily usage
├── lib/
│   ├── format.ts          # pure presentation helpers (dependency-free, tested)
│   ├── format.test.ts     # Node-runnable tests
│   ├── types.ts           # view row types
│   ├── supabaseServer.ts  # server-side client (service role; never exposed to browser)
│   └── metrics.ts         # typed queries against metrics_* views
├── package.json
├── next.config.mjs
└── tsconfig.json
```

## Security

- This reads with the **service-role key**, which bypasses RLS — it must run **server-side
  only** and the app must be deployed **behind access control** (internal/admin host).
- Do **not** prefix the service-role key with `NEXT_PUBLIC_`, and do not import
  `supabaseServer.ts` from a client component.

## Next steps

- Time-series **charts** (recharts/visx) for cost/tokens/DAU.
- Replace the service-role approach with **admin login** (sign in as a Supabase user who is
  in the `admins` table; the `metrics_*` views already enforce admin-only via RLS).
- Action-breakdown panel from `metrics_actions_daily`.
