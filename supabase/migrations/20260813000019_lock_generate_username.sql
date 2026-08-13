-- generate_username() only exists to be called from handle_new_user (which is security definer, so
-- it runs as the owner). Being in the public schema, PostgREST would otherwise expose it as
-- /rpc/generate_username to anyone — and called directly by a signed-in user it would check for
-- collisions under RLS, i.e. against their own row only. Take it off the API.

revoke all on function public.generate_username() from public;
revoke all on function public.generate_username() from anon;
revoke all on function public.generate_username() from authenticated;
