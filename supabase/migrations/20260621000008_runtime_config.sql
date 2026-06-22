-- Planfect — runtime config: a tiny key/value table so the developer dashboard can switch the
-- planner's provider/model at runtime, per surface (the signed-in app vs the public demo), WITHOUT
-- a redeploy. The edge functions read it (service role, short in-isolate cache); the dashboard
-- writes it behind Basic-Auth. Service-role only — RLS on with NO policies (denies anon/authenticated).

create table if not exists runtime_config (
  key        text primary key,
  value      text not null,
  updated_at timestamptz not null default now()
);

alter table runtime_config enable row level security;
-- (No policies on purpose: only the service role — the edge functions + the dashboard — touches it.)

-- Seed the four knobs to the current production model, so a fresh deploy behaves identically until
-- someone flips a dropdown. '*_app' drives /plan; '*_demo' drives /plan-demo.
insert into runtime_config (key, value) values
  ('planner_provider_app',  'openai'),
  ('planner_model_app',     'gpt-5.1-chat-latest'),
  ('planner_provider_demo', 'openai'),
  ('planner_model_demo',    'gpt-5.1-chat-latest')
on conflict (key) do nothing;
