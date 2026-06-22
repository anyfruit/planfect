-- Planfect — friends: usernames, directed friendship edges with per-side tiers, avatar storage.
-- Builds on the per-user RLS model: friendship rows are readable by either side, but all
-- mutations go through the `friends` edge function (service role) so the two directed rows
-- of a relationship stay consistent and requests are validated. Cross-user schedule reads
-- (a friend's calendar, blurred by tier) come in a later migration via a security-definer RPC.

-- ── usernames ───────────────────────────────────────────────────────────────
alter table profiles add column username text;
alter table profiles add column username_lower text
  generated always as (lower(username)) stored;
create unique index profiles_username_lower_key on profiles(username_lower);
alter table profiles add constraint profiles_username_format
  check (username is null or username ~ '^[A-Za-z0-9_]{3,20}$');

-- ── friendships ─────────────────────────────────────────────────────────────
create type friend_tier as enum ('friend', 'close');           -- 普通好友 / 密友
create type friendship_status as enum ('pending', 'accepted');

-- Directed edge: OWNER grants FRIEND access at `tier`. A relationship is two rows
-- (A→B and B→A); each side independently sets the tier it grants the other, which
-- governs what that other person may see/do to the owner.
create table friendships (
  owner_id     uuid not null references auth.users(id) on delete cascade,
  friend_id    uuid not null references auth.users(id) on delete cascade,
  status       friendship_status not null default 'pending',
  tier         friend_tier       not null default 'friend',
  requested_by uuid not null references auth.users(id) on delete cascade,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  primary key (owner_id, friend_id),
  constraint friendships_no_self check (owner_id <> friend_id)
);
create index friendships_friend_idx on friendships(friend_id);
create trigger trg_friendships_updated before update on friendships
  for each row execute function set_updated_at();

alter table friendships enable row level security;
-- Read edges on either side (my friends + requests to/from me). Writes: edge function only.
create policy "see my friendships" on friendships
  for select using (owner_id = auth.uid() or friend_id = auth.uid());

-- Tier that VIEWER is granted by OWNER, or null if they aren't accepted friends.
-- security definer so callers (and later the blurred-schedule RPC) can resolve it under RLS.
create or replace function friend_tier_of(viewer uuid, owner uuid)
returns friend_tier language sql stable security definer set search_path = public as $$
  select tier from friendships
  where owner_id = owner and friend_id = viewer and status = 'accepted'
$$;

-- ── avatar storage ──────────────────────────────────────────────────────────
insert into storage.buckets (id, name, public)
  values ('avatars', 'avatars', true)
  on conflict (id) do nothing;
-- Public read; each user may write only under a folder named by their uid (avatars/<uid>/…).
create policy "avatars public read" on storage.objects
  for select using (bucket_id = 'avatars');
create policy "avatars write own" on storage.objects
  for insert with check (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "avatars update own" on storage.objects
  for update using (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "avatars delete own" on storage.objects
  for delete using (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);
