-- Planfect — analytics & usage metering schema (powers the developer dashboard).
-- Apply AFTER schema.sql. Written by the Edge Functions (service role, which bypasses RLS);
-- readable only by admins. See docs/DASHBOARD.md.

-- ============================================================================
-- usage_events — one row per LLM call (the basis for token/cost/model comparison)
-- ============================================================================
create table usage_events (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid references auth.users(id) on delete set null,
  conversation_id     uuid,
  provider            text not null,         -- 'openai' | 'anthropic' | 'qwen' | ...
  model               text not null,
  action              text not null,         -- 'plan_step', ...
  input_tokens        int  not null default 0,
  output_tokens       int  not null default 0,
  cached_input_tokens int  not null default 0,
  cost_usd            numeric(12,6) not null default 0,
  latency_ms          int,
  success             boolean not null default true,
  source              text not null default 'app',   -- 'app' (signed-in planner) | 'demo' (public web demo)
  created_at          timestamptz not null default now()
);
create index usage_events_created_idx on usage_events(created_at);
create index usage_events_user_idx    on usage_events(user_id);
create index usage_events_model_idx   on usage_events(provider, model, created_at);
create index usage_events_source_idx  on usage_events(source, created_at);

-- ============================================================================
-- app_events — product analytics (actions/screens) for counts & active users
-- ============================================================================
create table app_events (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid references auth.users(id) on delete set null,
  type        text not null,   -- 'message_sent','voice_note','task_scheduled','question_answered',...
  metadata    jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);
create index app_events_created_idx on app_events(created_at);
create index app_events_type_idx    on app_events(type, created_at);

-- ============================================================================
-- admins — who may read the dashboard
-- ============================================================================
create table admins (
  user_id uuid primary key references auth.users(id) on delete cascade
);

create or replace function is_admin() returns boolean language sql stable as $$
  select exists (select 1 from admins where user_id = auth.uid());
$$;

-- RLS: normal users cannot read analytics. Inserts come from the service role (bypasses RLS).
alter table usage_events enable row level security;
alter table app_events   enable row level security;
alter table admins       enable row level security;

create policy "admins read usage_events" on usage_events for select using (is_admin());
create policy "admins read app_events"   on app_events   for select using (is_admin());
create policy "admins read admins"       on admins       for select using (is_admin());

-- ============================================================================
-- Dashboard views (security_invoker → respect the admin RLS above)
-- ============================================================================

-- Daily tokens + cost by provider/model
create view metrics_usage_daily with (security_invoker = true) as
  select date_trunc('day', created_at) as day,
         provider, model,
         count(*)                       as calls,
         sum(input_tokens)              as input_tokens,
         sum(output_tokens)             as output_tokens,
         sum(cached_input_tokens)       as cached_input_tokens,
         sum(cost_usd)                  as cost_usd,
         avg(latency_ms)                as avg_latency_ms,
         sum((not success)::int)        as errors
  from usage_events
  group by 1, 2, 3;

-- All-time model/provider comparison (the "compare models" panel)
create view metrics_model_comparison with (security_invoker = true) as
  select provider, model,
         count(*)                                              as calls,
         sum(input_tokens + output_tokens)                     as total_tokens,
         sum(cost_usd)                                         as cost_usd,
         avg(latency_ms)                                       as avg_latency_ms,
         round(100.0 * sum((not success)::int) / nullif(count(*), 0), 2) as error_rate_pct
  from usage_events
  group by 1, 2;

-- Daily active users + action volume
create view metrics_dau with (security_invoker = true) as
  select date_trunc('day', created_at) as day,
         count(distinct user_id)        as active_users,
         count(*)                       as actions
  from app_events
  group by 1;

-- Action breakdown by type per day
create view metrics_actions_daily with (security_invoker = true) as
  select date_trunc('day', created_at) as day,
         type,
         count(*) as count
  from app_events
  group by 1, 2;

-- Daily totals across all models, per source (the dashboard's "每天总额 / token")
create view metrics_usage_daily_total with (security_invoker = true) as
  select date_trunc('day', created_at) as day,
         source,
         count(*)                          as calls,
         sum(input_tokens + output_tokens) as total_tokens,
         sum(cost_usd)                     as cost_usd
  from usage_events
  group by 1, 2;

-- All-time usage split by source (app vs public demo)
create view metrics_usage_by_source with (security_invoker = true) as
  select source,
         count(*)                          as calls,
         sum(input_tokens + output_tokens) as total_tokens,
         sum(cost_usd)                     as cost_usd
  from usage_events
  group by 1;

-- ============================================================================
-- demo_conversations — public-demo chats, stored for the author to review.
-- Anonymous (no account); the IP is stored HASHED, never raw. Admin-read only;
-- inserts come from the /plan-demo Edge Function via the service role.
-- ============================================================================
create table demo_conversations (
  id          uuid primary key default gen_random_uuid(),
  created_at  timestamptz not null default now(),
  ip_hash     text,
  tz          text,
  model       text,
  result_type text,
  turns       int  not null default 0,
  messages    jsonb not null default '[]'::jsonb,
  result      jsonb
);
create index demo_conversations_created_idx on demo_conversations(created_at desc);
alter table demo_conversations enable row level security;
create policy "admins read demo_conversations" on demo_conversations for select using (is_admin());
