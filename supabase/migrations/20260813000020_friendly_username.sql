-- Make the assigned @id something a person can actually pass to a friend.
--
-- The first version produced `pf_k99wrby3` — correct and unique, but nobody can read that over
-- lunch, and adding friends is the whole point of having an id. Now it's two short common words
-- plus two digits: `mintotter42`, `sunnyfox07`. Same uniqueness guarantee (checked against the
-- username_lower index), still inside the 3–20 [A-Za-z0-9_] format, and typable from memory.
--
-- Words are deliberately plain, positive, and unambiguous when spoken aloud — no lookalike letters
-- carrying meaning, nothing that reads badly next to another word.

create or replace function public.generate_username()
returns text language plpgsql volatile set search_path = public as $$
declare
  adjectives constant text[] := array[
    'sunny','calm','brave','kind','swift','clever','quiet','bright','happy','lucky',
    'cozy','merry','neat','tidy','warm','bold','gentle','jolly','fresh','keen',
    'mellow','nimble','plucky','snug','spry','witty','zesty','breezy','chirpy','dandy'];
  nouns constant text[] := array[
    'otter','fox','panda','koala','robin','maple','olive','pebble','comet','meadow',
    'willow','harbor','lantern','pepper','cocoa','ginger','walnut','poppy','cedar','wren',
    'finch','heron','lynx','marmot','puffin','quokka','tapir','yak','bison','crane'];
  candidate text;
begin
  for _attempt in 1..25 loop
    candidate := adjectives[1 + floor(random() * array_length(adjectives, 1))::int]
              || nouns[1 + floor(random() * array_length(nouns, 1))::int]
              || lpad(floor(random() * 100)::int::text, 2, '0');
    if not exists (select 1 from profiles where username_lower = candidate) then
      return candidate;
    end if;
  end loop;
  -- 30 x 30 x 100 = 90k combinations; if 25 draws all collide, fall back to something that cannot.
  return 'planfect' || replace(gen_random_uuid()::text, '-', '');
end;
$$;

revoke all on function public.generate_username() from public;
revoke all on function public.generate_username() from anon;
revoke all on function public.generate_username() from authenticated;

-- Re-roll the ids that were auto-assigned yesterday in the unreadable format. Anything a user
-- chose themselves does not match `pf_` + 8 and is left alone.
do $$
declare r record;
begin
  for r in select id from profiles where username ~ '^pf_[a-z2-9]{8}$' loop
    update profiles set username = public.generate_username() where id = r.id;
  end loop;
end $$;
