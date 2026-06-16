-- Recurring tasks / habits ("gym every Mon/Wed/Fri 7am", "study daily"). Distinct from routines
-- (which are background the planner schedules AROUND): these are tasks to DO, repeated. Occurrences
-- are materialized into time_blocks over a rolling horizon by the Edge Function on each load;
-- `materialized_until` tracks how far we've created them, so a deleted occurrence isn't resurrected.
create table if not exists recurring_tasks (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null references auth.users(id) on delete cascade,
  title              text not null,
  category           text,
  days_of_week       int[] not null default '{}',   -- 0=Sun … 6=Sat
  start_local        text not null,                  -- 'HH:MM' in the user's timezone
  duration_min       int  not null default 60,
  active             boolean not null default true,
  materialized_until date,                           -- occurrences created through this date
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
create index if not exists recurring_tasks_user_idx on recurring_tasks(user_id);

create trigger trg_recurring_updated before update on recurring_tasks
  for each row execute function set_updated_at();

alter table recurring_tasks enable row level security;
create policy "own recurring" on recurring_tasks
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

-- Link a materialized occurrence back to its rule (cascade-delete when the rule is removed).
alter table time_blocks add column if not exists recurring_id uuid references recurring_tasks(id) on delete cascade;
