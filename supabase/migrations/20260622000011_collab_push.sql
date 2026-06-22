-- Planfect — P3 groundwork: collaborative (shared) blocks + push-notification tokens.

-- A plan made "with a friend" is written into BOTH calendars as two time_blocks that share one
-- shared_event_id, so each side owns/edits their own copy while staying linked.
alter table time_blocks add column shared_event_id uuid;
create index time_blocks_shared_idx on time_blocks(shared_event_id) where shared_event_id is not null;

-- APNs device tokens, one or more per user (a user may have several devices).
create table device_tokens (
  user_id    uuid not null references auth.users(id) on delete cascade,
  token      text not null,
  platform   text not null default 'ios',
  updated_at timestamptz not null default now(),
  primary key (user_id, token)
);
create index device_tokens_user_idx on device_tokens(user_id);
alter table device_tokens enable row level security;
-- A user manages only their own device tokens; the push sender uses the service role.
create policy "own device tokens" on device_tokens
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());
