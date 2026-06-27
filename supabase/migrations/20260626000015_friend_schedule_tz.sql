-- Per-event timezone for a friend's schedule. The viewer renders each of a friend's blocks at the
-- wall-clock the friend planned it in (e.g. a friend on a trip shows "busy 3pm PT"), instead of the
-- viewer's device zone. tz is blurred by tier exactly like the title/category: only a CLOSE friend
-- (and only for a non-private block) gets the real zone; a regular friend gets null and the client
-- falls back to its own device zone — so the zone never leaks more than the (already blurred) details.
--
-- Adding a column to the RETURNS TABLE changes the function's return type, which `create or replace`
-- refuses — so drop the old signature first, then recreate. (No explicit GRANTs to restore: the
-- function relies on Postgres's default PUBLIC EXECUTE, same as the original.)
drop function if exists friend_schedule(uuid, timestamptz, timestamptz);
create or replace function friend_schedule(target uuid, from_ts timestamptz, to_ts timestamptz)
returns table (start_at timestamptz, end_at timestamptz, title text, category text, kind text, tz text)
language plpgsql stable security definer set search_path = public as $$
declare
  t friend_tier;
begin
  t := friend_tier_of(auth.uid(), target);
  if t is null then
    return;
  end if;
  return query
    select tb.start_at,
           tb.end_at,
           case when t = 'close' and not tb.is_private then tb.title    else 'Busy' end as title,
           case when t = 'close' and not tb.is_private then tb.category else null   end as category,
           tb.kind::text,
           case when t = 'close' and not tb.is_private then tb.tz       else null   end as tz
    from time_blocks tb
    where tb.user_id = target
      and tb.start_at < to_ts
      and tb.end_at   > from_ts
      and tb.status <> 'skipped'
    order by tb.start_at;
end;
$$;
