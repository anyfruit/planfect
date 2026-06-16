-- Habit learning: a per-user store of durable preferences the planner reads on every turn and
-- updates when it learns something ("workouts in the morning", "groceries take ~45 min"). Kept
-- visible/editable in the app so the user stays in control of what's been learned.
create table if not exists preferences (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  text        text not null,                         -- the learned fact, in plain language
  source      text not null default 'learned',       -- 'learned' (by the agent) | 'user' (typed in)
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists preferences_user_idx on preferences(user_id);

create trigger trg_preferences_updated before update on preferences
  for each row execute function set_updated_at();

alter table preferences enable row level security;
create policy "own preferences" on preferences
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());
