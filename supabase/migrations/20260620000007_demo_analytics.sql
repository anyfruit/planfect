-- Planfect — demo analytics: log public-demo usage, add daily totals, and store demo conversations
-- for the author to review. Additive and non-destructive (apply after the existing analytics).

-- 1) Tag every usage_event with its source: the in-app planner vs the public web demo.
alter table usage_events add column if not exists source text not null default 'app';
create index if not exists usage_events_source_idx on usage_events (source, created_at);

-- 2) Daily totals across ALL models (the dashboard's "每天总额 / token" — one row per day per source).
create or replace view metrics_usage_daily_total with (security_invoker = true) as
  select date_trunc('day', created_at) as day,
         source,
         count(*)                          as calls,
         sum(input_tokens + output_tokens) as total_tokens,
         sum(cost_usd)                     as cost_usd
  from usage_events
  group by 1, 2;

-- 3) All-time usage split by source (app vs demo).
create or replace view metrics_usage_by_source with (security_invoker = true) as
  select source,
         count(*)                          as calls,
         sum(input_tokens + output_tokens) as total_tokens,
         sum(cost_usd)                     as cost_usd
  from usage_events
  group by 1;

-- 4) Store public-demo conversations so the author can review how guests actually use it.
--    Anonymous (no account): the IP is stored HASHED (never raw), and the table is admin-read only.
create table if not exists demo_conversations (
  id          uuid primary key default gen_random_uuid(),
  created_at  timestamptz not null default now(),
  ip_hash     text,                                   -- sha-256(ip) prefix, never the raw IP
  tz          text,
  model       text,
  result_type text,                                   -- scheduled | questions | message | error
  turns       int  not null default 0,                -- number of user turns in the thread
  messages    jsonb not null default '[]'::jsonb,     -- the user/assistant thread (recency stamp stripped)
  result      jsonb                                   -- the final receipt / questions / text
);
create index if not exists demo_conversations_created_idx on demo_conversations (created_at desc);

alter table demo_conversations enable row level security;
create policy "admins read demo_conversations" on demo_conversations for select using (is_admin());
-- Inserts come from the Edge Function via the service role (which bypasses RLS); no public access.
