-- Planfect — P2: a friend's schedule, blurred by tier (server-side, never on the client).
-- Regular friends see only busy/free (title → "Busy"); close friends see specifics, EXCEPT any
-- block the owner marked private. The owner's own RLS still hides their rows from everyone — this
-- security-definer RPC is the ONLY way a friend reads them, and it validates the friendship + tier
-- and blurs before returning, so no un-permitted detail ever leaves the database.

-- Per-block privacy: force "Busy" even for close friends when set.
alter table time_blocks add column is_private boolean not null default false;

create or replace function friend_schedule(target uuid, from_ts timestamptz, to_ts timestamptz)
returns table (start_at timestamptz, end_at timestamptz, title text, category text, kind text)
language plpgsql stable security definer set search_path = public as $$
declare
  t friend_tier;
begin
  -- The tier the target grants the caller; null when they aren't accepted friends → empty result.
  t := friend_tier_of(auth.uid(), target);
  if t is null then
    return;
  end if;
  return query
    select tb.start_at,
           tb.end_at,
           case when t = 'close' and not tb.is_private then tb.title    else 'Busy' end as title,
           case when t = 'close' and not tb.is_private then tb.category else null   end as category,
           tb.kind
    from time_blocks tb
    where tb.user_id = target
      and tb.start_at < to_ts
      and tb.end_at   > from_ts
      and tb.status <> 'skipped'
    order by tb.start_at;
end;
$$;
