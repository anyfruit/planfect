-- The Friends tab's list took TWO database round trips: read my edges, then (in parallel) the
-- friends' profiles and the reverse edges for the tier they grant me. This collapses it into one.
--
-- security definer because the caller is the `friends` edge function running as the service role,
-- and because it reads the reverse edges + profiles of other users. Execute is revoked from anon
-- and authenticated so nobody can pass someone else's uuid as p_user — only service_role may call it.

create or replace function public.friends_list(p_user uuid)
returns json
language sql
stable
security definer
set search_path = public
as $$
  with edges as (
    select f.friend_id, f.status, f.tier, f.requested_by
    from friendships f
    where f.owner_id = p_user
  ),
  shaped as (
    select
      e.status,
      e.requested_by,
      json_build_object(
        'id',           e.friend_id,
        'username',     p.username,
        'display_name', p.display_name,
        'avatar_url',   p.avatar_url,
        'my_tier',      e.tier,          -- the tier I grant them
        'their_tier',   r.tier           -- the tier they grant me (null if no reverse edge)
      ) as person
    from edges e
    left join profiles p on p.id = e.friend_id
    left join friendships r on r.owner_id = e.friend_id and r.friend_id = p_user
  )
  select json_build_object(
    'friends',  coalesce((select json_agg(person) from shaped
                          where status = 'accepted'), '[]'::json),
    'incoming', coalesce((select json_agg(person) from shaped
                          where status = 'pending' and requested_by <> p_user), '[]'::json),
    'outgoing', coalesce((select json_agg(person) from shaped
                          where status = 'pending' and requested_by = p_user), '[]'::json)
  );
$$;

revoke all on function public.friends_list(uuid) from public;
revoke all on function public.friends_list(uuid) from anon;
revoke all on function public.friends_list(uuid) from authenticated;
grant execute on function public.friends_list(uuid) to service_role;
