-- Fix: friend_schedule returned `kind text`, but time_blocks.kind is a block_kind ENUM, so the
-- SELECT failed (HTTP 400) once a real friendship made the query actually run (non-friends return
-- early, which is why it only surfaced when viewing an accepted friend's calendar). Cast kind to text.
create or replace function friend_schedule(target uuid, from_ts timestamptz, to_ts timestamptz)
returns table (start_at timestamptz, end_at timestamptz, title text, category text, kind text)
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
           tb.kind::text
    from time_blocks tb
    where tb.user_id = target
      and tb.start_at < to_ts
      and tb.end_at   > from_ts
      and tb.status <> 'skipped'
    order by tb.start_at;
end;
$$;
