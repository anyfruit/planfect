-- Planfect — initial Postgres schema for Supabase
-- ------------------------------------------------------------------------------------
-- Apply with: supabase db reset (local) or via the SQL editor / a migration.
-- Every user-owned table enables Row-Level Security (RLS) scoped to auth.uid(),
-- so a user can only ever read/write their own rows. See docs/DATA_MODEL.md.
-- ------------------------------------------------------------------------------------

create extension if not exists pgcrypto;        -- gen_random_uuid()

-- ============================================================================
-- Enums
-- ============================================================================
create type routine_kind   as enum ('work', 'sleep', 'meal', 'commute', 'custom');
create type task_status    as enum ('pending', 'scheduled', 'in_progress', 'done', 'cancelled');
create type task_source    as enum ('chat', 'voice', 'manual');
create type block_kind     as enum ('task', 'routine', 'commute', 'buffer');
create type block_status   as enum ('planned', 'confirmed', 'done', 'skipped');
create type transport_mode as enum ('driving', 'transit', 'walking', 'cycling');
create type message_role   as enum ('user', 'assistant', 'tool', 'system');

-- ============================================================================
-- Helper: keep updated_at current
-- ============================================================================
create or replace function set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- ============================================================================
-- profiles — 1:1 with auth.users; the user's personal info & defaults
-- ============================================================================
create table profiles (
  id               uuid primary key references auth.users(id) on delete cascade,
  display_name     text,
  avatar_url       text,
  timezone         text        not null default 'UTC',     -- IANA, e.g. 'America/New_York'
  home_location_id uuid,                                    -- FK added after locations exists
  work_location_id uuid,
  -- ordered preference of transport modes for commute estimates
  preferred_modes  transport_mode[] not null default '{transit,walking,driving}',
  -- default working-day bounds used as a hint before a full routine is set
  workday_start    time        not null default '09:00',
  workday_end      time        not null default '17:00',
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

-- ============================================================================
-- locations — places the user references (home, work, the dentist, …)
-- ============================================================================
create table locations (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users(id) on delete cascade,
  name          text not null,                 -- 'Home', 'Dr. Lee Dental', …
  address       text,
  lat           double precision,
  lng           double precision,
  place_id      text,                           -- provider place id (Apple/Google/Amap)
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index locations_user_idx on locations(user_id);

-- now that locations exists, wire up the profile FKs
alter table profiles
  add constraint profiles_home_fk foreign key (home_location_id) references locations(id) on delete set null,
  add constraint profiles_work_fk foreign key (work_location_id) references locations(id) on delete set null;

-- ============================================================================
-- routines — recurring life blocks the planner schedules AROUND (the "routine")
--   e.g. work Mon–Fri 09:00–17:00, sleep daily 23:00–07:00, lunch 12:30–13:00
-- ============================================================================
create table routines (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users(id) on delete cascade,
  label         text not null,
  kind          routine_kind not null default 'custom',
  -- days of week this applies to: 0=Sunday … 6=Saturday
  days_of_week  int[] not null default '{}',
  start_time    time not null,
  end_time      time not null,                  -- may be < start_time for overnight (sleep)
  location_id   uuid references locations(id) on delete set null,
  is_flexible   boolean not null default false, -- false = inviolable background
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint routines_dow_valid check (
    days_of_week <@ array[0,1,2,3,4,5,6]
  )
);
create index routines_user_idx on routines(user_id);

-- ============================================================================
-- tasks — things the user wants to do (the planner schedules these into free time)
-- ============================================================================
create table tasks (
  id                    uuid primary key default gen_random_uuid(),
  user_id               uuid not null references auth.users(id) on delete cascade,
  title                 text not null,
  notes                 text,
  estimated_duration_min int,                    -- model-estimated if user didn't say
  status                task_status not null default 'pending',
  priority              int not null default 0,  -- higher = more important
  location_id           uuid references locations(id) on delete set null,
  earliest_start        timestamptz,             -- "not before"
  deadline              timestamptz,             -- "by"
  is_multi_session      boolean not null default false, -- can be split across blocks
  rrule                 text,                    -- optional recurrence (RFC 5545), future use
  source                task_source not null default 'chat',
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);
create index tasks_user_idx on tasks(user_id);
create index tasks_user_status_idx on tasks(user_id, status);

-- ============================================================================
-- time_blocks — the materialized schedule the Timetable reads.
--   One row per concrete block on the calendar: a scheduled task, a routine
--   instance, a commute leg, or a buffer. Commute blocks use origin/destination.
-- ============================================================================
create table time_blocks (
  id                     uuid primary key default gen_random_uuid(),
  user_id                uuid not null references auth.users(id) on delete cascade,
  title                  text not null,
  kind                   block_kind not null,
  status                 block_status not null default 'planned',
  start_at               timestamptz not null,
  end_at                 timestamptz not null,
  task_id                uuid references tasks(id) on delete cascade,
  routine_id             uuid references routines(id) on delete set null,
  location_id            uuid references locations(id) on delete set null,
  -- commute-specific (kind = 'commute')
  origin_location_id     uuid references locations(id) on delete set null,
  destination_location_id uuid references locations(id) on delete set null,
  transport_mode         transport_mode,
  category               text,                    -- semantic type for display (work/fitness/meal/…)
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  constraint time_blocks_range check (end_at > start_at)
);
create index time_blocks_user_time_idx on time_blocks(user_id, start_at);
create index time_blocks_task_idx on time_blocks(task_id);

-- ============================================================================
-- conversations + messages — the chat with the planning assistant
-- ============================================================================
create table conversations (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  title       text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index conversations_user_idx on conversations(user_id);

create table messages (
  id              uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references conversations(id) on delete cascade,
  user_id         uuid not null references auth.users(id) on delete cascade,
  role            message_role not null,
  -- text content for plain turns; structured payload for clarifying-question cards,
  -- tool calls/results, and scheduling receipts (see docs/AI_PLANNING.md)
  content         jsonb not null default '{}'::jsonb,
  created_at      timestamptz not null default now()
);
create index messages_conversation_idx on messages(conversation_id, created_at);

-- ============================================================================
-- updated_at triggers
-- ============================================================================
create trigger trg_profiles_updated     before update on profiles      for each row execute function set_updated_at();
create trigger trg_locations_updated     before update on locations     for each row execute function set_updated_at();
create trigger trg_routines_updated      before update on routines      for each row execute function set_updated_at();
create trigger trg_tasks_updated         before update on tasks         for each row execute function set_updated_at();
create trigger trg_time_blocks_updated   before update on time_blocks   for each row execute function set_updated_at();
create trigger trg_conversations_updated before update on conversations for each row execute function set_updated_at();

-- ============================================================================
-- Auto-create a profile row when a new auth user signs up
-- ============================================================================
create or replace function handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, display_name, avatar_url)
  values (new.id, new.raw_user_meta_data->>'name', new.raw_user_meta_data->>'avatar_url');
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function handle_new_user();

-- ============================================================================
-- Row-Level Security — each user sees only their own rows
-- ============================================================================
alter table profiles      enable row level security;
alter table locations     enable row level security;
alter table routines      enable row level security;
alter table tasks         enable row level security;
alter table time_blocks   enable row level security;
alter table conversations enable row level security;
alter table messages      enable row level security;

-- profiles keyed by id (= auth.uid())
create policy "own profile" on profiles
  for all using (id = auth.uid()) with check (id = auth.uid());

-- the rest are keyed by user_id
create policy "own locations"     on locations     for all using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "own routines"      on routines      for all using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "own tasks"         on tasks         for all using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "own time_blocks"   on time_blocks   for all using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "own conversations" on conversations for all using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "own messages"      on messages      for all using (user_id = auth.uid()) with check (user_id = auth.uid());
