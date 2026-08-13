-- Every account gets a system-assigned @id at signup.
--
-- Until now `profiles.username` was null until the user set one by hand, so most accounts had no
-- handle at all — nothing to show them, and nothing for a friend to search for. The generated id is
-- a normal username: unique, and editable later (that edit is where a paid "pick your own id" perk
-- would hang).
--
-- Format: pf_ + 8 chars from a no-ambiguity alphabet (no 0/O/1/l/I), e.g. pf_k7m3n2qa — 11 chars,
-- inside the existing profiles_username_format check (3–20 of [A-Za-z0-9_]).

create or replace function public.generate_username()
returns text language plpgsql volatile set search_path = public as $$
declare
  alphabet constant text := 'abcdefghjkmnpqrstuvwxyz23456789';
  candidate text;
begin
  -- The unique index on username_lower is the real guard; loop until we miss every existing handle.
  for _attempt in 1..20 loop
    candidate := 'pf_';
    for _i in 1..8 loop
      candidate := candidate || substr(alphabet, 1 + floor(random() * length(alphabet))::int, 1);
    end loop;
    if not exists (select 1 from profiles where username_lower = candidate) then
      return candidate;
    end if;
  end loop;
  -- 31^8 keyspace: 20 collisions in a row means something is very wrong. Fall back to a value that
  -- cannot collide rather than leaving the account without an id.
  return 'pf_' || replace(gen_random_uuid()::text, '-', '');
end;
$$;

create or replace function handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, display_name, avatar_url, username)
  values (new.id, new.raw_user_meta_data->>'name', new.raw_user_meta_data->>'avatar_url',
          public.generate_username());
  return new;
end;
$$;

-- Backfill: existing accounts have no handle either.
do $$
declare r record;
begin
  for r in select id from profiles where username is null loop
    update profiles set username = public.generate_username() where id = r.id;
  end loop;
end $$;
