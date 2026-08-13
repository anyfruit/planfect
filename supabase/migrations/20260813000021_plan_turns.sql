-- A finished planning turn, kept so the reply survives the client losing the connection.
--
-- The schedule itself was never at risk — the tools write tasks/time_blocks server-side no matter
-- what the app does. What was lost when the user backgrounded the app mid-turn was the model's
-- REPLY: the confirmation text, the receipt card, or the clarifying questions. The client now sends
-- a turn_id up front and can come back for that exact turn's result whenever it reconnects.
--
-- Rows are disposable: a turn is only interesting until the app has collected it.

create table plan_turns (
  id         uuid primary key,                                    -- client-generated, so it can ask for this turn back
  user_id    uuid not null references auth.users(id) on delete cascade,
  result     jsonb not null,                                      -- the PlannerResult the app would have received
  created_at timestamptz not null default now()
);
create index plan_turns_user_idx on plan_turns(user_id, created_at desc);

alter table plan_turns enable row level security;
-- Read your own turns. Writes come from the Edge Function's service-role client only.
create policy "see my plan turns" on plan_turns
  for select using (user_id = auth.uid());
