-- Planfect — P3: a notification queue. Producers (the planner's double-booking, the friends
-- function's request/accept) insert rows here; the APNs sender (lands with the push key) drains
-- undelivered ones and marks them delivered. Decoupling means push works even when added later.
create table notifications (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users(id) on delete cascade,   -- recipient
  kind       text not null,                                               -- friend_request | friend_accept | scheduled_with
  actor_id   uuid references auth.users(id) on delete set null,           -- who triggered it
  body       text,
  delivered  boolean not null default false,
  created_at timestamptz not null default now()
);
create index notifications_undelivered_idx on notifications(created_at) where not delivered;
alter table notifications enable row level security;
-- A user may read their own notifications; all writes go through the service role.
create policy "see my notifications" on notifications for select using (user_id = auth.uid());
