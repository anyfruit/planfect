// Supabase Edge Function: POST /friends  (Deno runtime).
// One endpoint for all friend management — search, request, accept, decline, remove, set tier, list.
// Auth is the caller's JWT; the caller's uid is taken from the verified token (NEVER from the body),
// then every mutation runs with the service role so the TWO directed rows of a friendship
// (owner→friend and friend→owner) always stay consistent. See migration 20260622000009_friends.sql.

import { createClient, SupabaseClient } from 'jsr:@supabase/supabase-js@2';
import { sendPush } from '../_shared/apns.ts';

declare const Deno: { env: { get(k: string): string | undefined }; serve(h: (r: Request) => Promise<Response>): void };

type Tier = 'friend' | 'close';
interface Body {
  action?: string;
  q?: string;
  target_id?: string;
  requester_id?: string;
  friend_id?: string;
  tier?: Tier;
}

const PROFILE = 'id, username, display_name, avatar_url';

Deno.serve(async (req: Request): Promise<Response> => {
  try {
    const authHeader = req.headers.get('Authorization') ?? '';
    const url = Deno.env.get('SUPABASE_URL')!;
    // The platform verifies the JWT before this function runs (a forged or missing token never gets
    // here — it's rejected with UNAUTHORIZED_*), so read the caller's uid straight from the verified
    // payload. `auth.getUser()` would be a second network round trip on every request, ~150ms of the
    // ~250ms this function spends server-side. Fall back to it if the payload is unreadable.
    let me = uidFromJWT(authHeader);
    if (!me) {
      const userClient = createClient(url, Deno.env.get('SUPABASE_ANON_KEY')!, {
        global: { headers: { Authorization: authHeader } },
        auth: { persistSession: false },
      });
      const { data: { user } } = await userClient.auth.getUser();
      if (!user) return json({ error: 'unauthorized' }, 401);
      me = user.id.toLowerCase();
    }

    const srKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    if (!srKey) return json({ error: 'not configured' }, 500);
    const db = createClient(url, srKey, { auth: { persistSession: false } });

    const body = (await req.json()) as Body;
    // Swift's UUID.uuidString is UPPERCASE; Postgres returns lowercase. Normalize every client-sent
    // id to lowercase so JS string comparisons (e.g. the requested_by check) match the DB values.
    const targetId = body.target_id?.toLowerCase();
    const requesterId = body.requester_id?.toLowerCase();
    const friendId = body.friend_id?.toLowerCase();
    switch (body.action) {
      case 'search':   return await search(db, me, body.q ?? '');
      case 'request':  return await request(db, me, targetId);
      case 'accept':   return await accept(db, me, requesterId);
      case 'decline':  return await unlink(db, me, requesterId);   // reject incoming / cancel outgoing
      case 'remove':   return await unlink(db, me, friendId);      // unfriend
      case 'set_tier': return await setTier(db, me, friendId, body.tier);
      case 'list':     return await list(db, me);
      default:         return json({ error: 'unknown action' }, 400);
    }
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }
});

/** Find users by username prefix, labelled with my relationship to each. */
async function search(db: SupabaseClient, me: string, raw: string): Promise<Response> {
  const q = raw.trim().toLowerCase();
  if (q.length < 2) return json({ results: [] });
  const { data: profs } = await db.from('profiles').select(PROFILE)
    .ilike('username_lower', `${q}%`).neq('id', me).limit(20);
  const list = profs ?? [];
  // My outgoing edge (owner=me) to each carries status + who requested → enough to label.
  const ids = list.map((p) => p.id as string);
  const mine: Record<string, { status: string; requested_by: string }> = {};
  if (ids.length) {
    const { data: edges } = await db.from('friendships')
      .select('friend_id, status, requested_by').eq('owner_id', me).in('friend_id', ids);
    for (const e of edges ?? []) mine[e.friend_id as string] = { status: e.status as string, requested_by: e.requested_by as string };
  }
  const results = list.map((p) => {
    const e = mine[p.id as string];
    let relationship = 'none';
    if (e?.status === 'accepted') relationship = 'friends';
    else if (e?.status === 'pending') relationship = e.requested_by === me ? 'requested' : 'incoming';
    return { ...p, relationship };
  });
  return json({ results });
}

/** Send a friend request (or auto-accept if they already requested me). */
async function request(db: SupabaseClient, me: string, target?: string): Promise<Response> {
  if (!target || target === me) return json({ error: 'bad target' }, 400);
  const { data: prof } = await db.from('profiles').select('id').eq('id', target).maybeSingle();
  if (!prof) return json({ error: 'no such user' }, 404);

  const { data: existing } = await db.from('friendships')
    .select('status, requested_by').eq('owner_id', me).eq('friend_id', target).maybeSingle();
  if (existing?.status === 'accepted') return json({ ok: true, status: 'friends' });
  if (existing?.status === 'pending' && existing.requested_by === target) {
    await setAccepted(db, me, target);                         // they asked first → this accepts it
    await notify(db, target, 'friend_accept', me);
    return json({ ok: true, status: 'friends' });
  }
  await db.from('friendships').upsert([
    { owner_id: me, friend_id: target, status: 'pending', requested_by: me },
    { owner_id: target, friend_id: me, status: 'pending', requested_by: me },
  ], { onConflict: 'owner_id,friend_id', ignoreDuplicates: true });
  await notify(db, target, 'friend_request', me);
  return json({ ok: true, status: 'requested' });
}

/** Accept a pending request that `requester` sent me. */
async function accept(db: SupabaseClient, me: string, requester?: string): Promise<Response> {
  if (!requester) return json({ error: 'bad requester' }, 400);
  const { data: edge } = await db.from('friendships')
    .select('status, requested_by').eq('owner_id', me).eq('friend_id', requester).maybeSingle();
  if (!edge || edge.status !== 'pending' || edge.requested_by !== requester) {
    return json({ error: 'no pending request' }, 400);
  }
  await setAccepted(db, me, requester);
  await notify(db, requester, 'friend_accept', me);
  return json({ ok: true, status: 'friends' });
}

/** Delete both directed rows — used for declining, cancelling, and unfriending. */
async function unlink(db: SupabaseClient, me: string, other?: string): Promise<Response> {
  if (!other) return json({ error: 'bad id' }, 400);
  await db.from('friendships').delete().eq('owner_id', me).eq('friend_id', other);
  await db.from('friendships').delete().eq('owner_id', other).eq('friend_id', me);
  return json({ ok: true });
}

/** Set the tier I grant a friend (governs what THEY can see/do to ME). */
async function setTier(db: SupabaseClient, me: string, friend?: string, tier?: Tier): Promise<Response> {
  if (!friend || (tier !== 'friend' && tier !== 'close')) return json({ error: 'bad args' }, 400);
  const { error } = await db.from('friendships').update({ tier })
    .eq('owner_id', me).eq('friend_id', friend).eq('status', 'accepted');
  if (error) return json({ error: error.message }, 400);
  return json({ ok: true });
}

/**
 * My friends (accepted) plus pending requests in both directions, each with profile + tiers.
 * ONE round trip: the join (my edges → their profiles → the reverse edge for the tier they grant
 * me) happens in `friends_list`, a security-definer function only service_role may execute. This
 * used to be two sequential round trips, and it is the request the Friends tab blocks on.
 */
async function list(db: SupabaseClient, me: string): Promise<Response> {
  const { data, error } = await db.rpc('friends_list', { p_user: me });
  if (error) return json({ error: error.message }, 500);
  return json(data ?? { friends: [], incoming: [], outgoing: [] });
}

/** Flip both directed rows of a relationship to accepted. */
async function setAccepted(db: SupabaseClient, a: string, b: string): Promise<void> {
  await db.from('friendships').update({ status: 'accepted' }).eq('owner_id', a).eq('friend_id', b);
  await db.from('friendships').update({ status: 'accepted' }).eq('owner_id', b).eq('friend_id', a);
}

/** Record + push a notification (best-effort). */
async function notify(db: SupabaseClient, userId: string, kind: string, actorId: string): Promise<void> {
  const { data: actor } = await db.from('profiles').select('display_name,username').eq('id', actorId).maybeSingle();
  const name = (actor?.display_name as string) || (actor?.username as string) || 'Someone';
  const body = kind === 'friend_request'
    ? `${name} sent you a friend request`
    : `${name} accepted your friend request`;
  await db.from('notifications').insert({ user_id: userId, kind, actor_id: actorId, body, delivered: true });
  await sendPush(db, userId, 'Planfect', body);
}

/**
 * The `sub` claim of an already-verified bearer token, lowercased. NOT a verification step — the
 * Edge Function gateway rejects anything unsigned or expired before we run; this only reads the id
 * out of a token that has already passed. Returns null on anything unexpected so the caller can
 * fall back to `auth.getUser()`.
 */
function uidFromJWT(authHeader: string): string | null {
  try {
    const token = authHeader.replace(/^Bearer\s+/i, '').trim();
    const payload = token.split('.')[1];
    if (!payload) return null;
    const padded = payload.replace(/-/g, '+').replace(/_/g, '/');
    const json = JSON.parse(atob(padded + '='.repeat((4 - padded.length % 4) % 4)));
    const sub = json?.sub;
    return typeof sub === 'string' && UUID_RE.test(sub) ? sub.toLowerCase() : null;
  } catch {
    return null;
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
}
