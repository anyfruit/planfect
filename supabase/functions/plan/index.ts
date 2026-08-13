// Supabase Edge Function: POST /plan  (Deno runtime).
// Wires the unit-tested server/ modules to Supabase Auth + Postgres + a maps/LLM provider.
//
// DEPLOY-TIME code — it imports Deno/Supabase and is NOT run by the Node unit tests (those
// cover the pure logic via MockPlanner). For a runnable end-to-end walkthrough on Node, see
// server/demo/planDemo.ts. Deploy with: supabase functions deploy plan

import { createClient, type SupabaseClient } from 'jsr:@supabase/supabase-js@2';
import { runPlanner, type PlannerDeps, type PlannerEvent, type PlannerResult } from '../../../server/planner.ts';
import { createPlanner } from '../../../server/llm/providers.ts';
import { PLANNER_TOOLS } from '../../../server/llm/tools.ts';
import { type LLMMessage, type LLMProvider } from '../../../server/llm/types.ts';
import { buildHandlers, loadContext, buildSystemPrompt, SupabaseUsageSink, getPlannerConfig } from './handlers.ts';

declare const Deno: { env: { get(k: string): string | undefined }; serve(h: (r: Request) => Promise<Response>): void };

Deno.serve(async (req: Request): Promise<Response> => {
  // Per-turn observability (dashboard "agent health"): one plan_turn app_event per request —
  // result type, model steps, integrity-nudge count, end-to-end latency, and errors.
  const t0 = Date.now();
  let obs: SupabaseClient | null = null;
  let obsUserId: string | null = null;
  let obsProvider = '';
  let obsModel = '';
  try {
    // Authenticate as the caller (their JWT) so RLS applies; derive user_id server-side.
    const authHeader = req.headers.get('Authorization') ?? '';
    const url = Deno.env.get('SUPABASE_URL')!;
    // User-context client: RLS applies as the caller, so it only reads/writes their own rows.
    const supabase = createClient(url, Deno.env.get('SUPABASE_ANON_KEY')!, {
      global: { headers: { Authorization: authHeader } },
      auth: { persistSession: false },
    });
    // Service-role client: analytics sinks (usage_events / app_events) that must bypass RLS.
    const admin = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
      auth: { persistSession: false },
    });
    obs = admin;
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return json({ error: 'unauthorized' }, 401);
    obsUserId = user.id;

    const body = await req.json();
    const conversationId: string | undefined = body.conversation_id;

    // Reconnect path: the app lost the stream (backgrounded, killed, network flipped) and is asking
    // for that turn's saved result. Cheap, and RLS-scoped by the user client.
    if (typeof body.fetch_turn === 'string') {
      const { data } = await supabase
        .from('plan_turns').select('result').eq('id', body.fetch_turn).maybeSingle();
      return data ? json({ ...(data.result as Record<string, unknown>), turn_id: body.fetch_turn })
                  : json({ pending: true, turn_id: body.fetch_turn });
    }
    // The client supplies the id so it can come back for this exact turn even if the response
    // never arrives. UUIDs from the app; fall back to one of ours for callers that omit it.
    const turnId: string = typeof body.turn_id === 'string' && UUID_RE.test(body.turn_id)
      ? body.turn_id : crypto.randomUUID();
    let messages: LLMMessage[] = body.messages ?? [{ role: 'user', content: String(body.text ?? '') }];
    // The app replays the WHOLE chat every turn, and threads live for weeks — a 30k-token history
    // slows every model step, costs real tokens, and feeds the model stale ids/dates from old days
    // (the "couldn't change my plan" incident). Planning needs only the recent turns: keep the tail,
    // cutting at a USER-turn boundary so no assistant tool call is separated from its results.
    const MAX_THREAD_MESSAGES = 40;
    if (messages.length > MAX_THREAD_MESSAGES) {
      let cut = messages.length - MAX_THREAD_MESSAGES;
      while (cut < messages.length && messages[cut].role !== 'user') cut++;
      if (cut < messages.length) messages = messages.slice(cut);
    }

    // Provider + model come from runtime_config (the dashboard's model switcher, surface 'app'),
    // falling back to env then a default. If the chosen provider has no key configured, fall back to
    // OpenAI so a misconfigured switch never hard-fails the planner.
    const cfg = await getPlannerConfig(admin, 'app', Deno.env.get('ACTIVE_LLM_PROVIDER'), Deno.env.get('PLANNER_MODEL'));
    let provider = cfg.provider as LLMProvider;
    let model = cfg.model;
    let apiKey = Deno.env.get(providerKeyEnv(provider));
    if (!apiKey) {
      provider = 'openai';
      model = Deno.env.get('PLANNER_MODEL') || 'gpt-5.5';
      apiKey = Deno.env.get('OPENAI_API_KEY');
    }
    obsProvider = provider;
    obsModel = model;

    const ctx = await loadContext(supabase, user.id, admin);
    // Planning timezone = where the user IS right now (the device's current zone, sent each request),
    // falling back to their saved profile tz. This is what makes per-event timezone work: plans made
    // on a trip are anchored to the trip's zone and keep showing that wall-clock afterward. The model
    // can still override an individual task's zone (schedule_tasks.timezone) when pre-planning for a
    // place the user isn't in yet. Validate before trusting it so a bad header can't break time math.
    const deviceTz = typeof body.device_timezone === 'string' ? body.device_timezone.trim() : '';
    if (deviceTz) {
      try { new Intl.DateTimeFormat('en-US', { timeZone: deviceTz }); ctx.timezone = deviceTz; } catch { /* keep profile tz */ }
    }
    // Real device-calendar events the app passes in, so the planner schedules around them.
    ctx.calendarBusy = ((body.calendar_busy ?? []) as Array<{ start: string; end: string; title?: string }>)
      .map((c) => ({ start: Date.parse(c.start), end: Date.parse(c.end), title: String(c.title ?? 'Busy') }))
      .filter((c) => Number.isFinite(c.start) && Number.isFinite(c.end) && c.end > c.start);

    // Anchor "today" with maximum recency. The app sends the FULL chat thread every turn and it
    // persists across days, so a long multi-day history can drag the model's sense of "today"
    // backward (e.g. resolving 今天 to a date from an old turn). Stamp the CURRENT date/time onto the
    // latest user turn — the most recent, most salient signal — and strip any prior stamp so stale
    // dates never accumulate or reach the model.
    const nowTag = /^\[Now: .*?\]\n/;
    const nowStamp = new Intl.DateTimeFormat('en-US', {
      timeZone: ctx.timezone, weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
      hour: 'numeric', minute: '2-digit',
    }).format(new Date());
    let stampedLatest = false;
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m.role !== 'user' || typeof m.content !== 'string') continue;
      const base = m.content.replace(nowTag, '');
      messages[i] = {
        ...m,
        content: stampedLatest ? base
          : `[Now: ${nowStamp} ${ctx.timezone}. Resolve 今天/明天/后天/这周/dates from THIS; ignore any dates mentioned earlier in this chat — they may be from previous days.]\n${base}`,
      };
      stampedLatest = true;
    }

    // Freemium gate (dormant unless BILLING_ENFORCED=1): free users get a monthly AI-usage budget;
    // over it, return an upsell instead of spending more on the model. Pro = unlimited.
    const billingEnforced = Deno.env.get('BILLING_ENFORCED') === '1';
    if (billingEnforced && !ctx.isPro) {
      const used = await freeUsageThisMonth(admin, user.id);
      const limit = Number(Deno.env.get('FREE_MONTHLY_AI_UNITS') ?? '150');
      if (used >= limit) {
        return json({ type: 'upgrade', text: 'You\'ve used up this month\'s free planning. Upgrade to Planfect Pro for unlimited planning, real travel times, event lookups, AI insights, recurring habits and calendar sync.' });
      }
    }

    // Baselines for the per-turn deltas: the app replays the whole thread, so new steps/nudges
    // this turn = counts in the result thread minus counts in the input thread.
    const inSteps = countAssistant(messages);
    const inNudges = countNudges(messages);

    const plannerDeps = {
      llm: createPlanner(provider, { apiKey: apiKey ?? '' }),
      model,
      system: buildSystemPrompt(ctx),
      tools: PLANNER_TOOLS,
      handlers: buildHandlers(supabase, user.id, ctx, admin, Deno.env.get('OPENAI_API_KEY'), Deno.env.get('GOOGLE_MAPS_API_KEY'), billingEnforced),
      context: { userId: user.id, conversationId },
      usage: new SupabaseUsageSink(admin),
      maxSteps: 14,
    };
    const finish = (result: PlannerResult) => {
      logTurn(admin, user.id, {
        ok: true,
        type: result.type,
        steps: countAssistant(result.messages) - inSteps,
        nudges: countNudges(result.messages) - inNudges,
        ms: Date.now() - t0,
        provider,
        model,
        streamed: body.stream === true,
      });
      // Persist the finished turn so a client that lost the connection (backgrounded, killed,
      // switched networks) can still collect the model's ACTUAL reply instead of losing it. The
      // schedule itself was already written by the tools; this is the reply text/receipt.
      saveTurn(admin, user.id, turnId, result);
    };

    // Streaming turn: the client gets tool-progress and the reply as it is written, and the same
    // final payload it would have received from the buffered call. Old clients don't set
    // `stream`, so they keep the byte-identical JSON response.
    if (body.stream === true) {
      return streamTurn(messages, plannerDeps, turnId, finish);
    }

    const result = await runPlanner(messages, plannerDeps);
    finish(result);
    return json({ ...result, turn_id: turnId });
  } catch (e) {
    if (obs) {
      logTurn(obs, obsUserId, {
        ok: false, error: (e as Error).message, ms: Date.now() - t0,
        provider: obsProvider, model: obsModel,
      });
    }
    return json({ error: (e as Error).message }, 500);
  }
});

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Run the turn as Server-Sent Events: `tool` / `delta` while it works, then one `result` frame
 * carrying exactly the payload the buffered endpoint returns.
 *
 * The planner is NOT tied to the response stream: if the client disappears mid-turn, the loop
 * still runs to completion and `finish` still persists the result, which is the whole point —
 * the user gets their reply back when they return, however long that takes.
 */
function streamTurn(
  messages: LLMMessage[],
  deps: Omit<PlannerDeps, 'onEvent'>,
  turnId: string,
  finish: (r: PlannerResult) => void,
): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      let open = true;
      const write = (frame: string) => {
        if (!open) return;   // client hung up — keep planning, just stop writing
        try {
          controller.enqueue(encoder.encode(frame));
        } catch {
          open = false;
        }
      };
      const send = (event: string, data: unknown) =>
        write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      send('open', { turn_id: turnId });
      // Keep bytes moving. A turn can spend 15+ seconds inside ONE model step with nothing to
      // report, and a connection that goes silent that long gets reaped by carrier NAT and other
      // middleboxes — which is exactly the "connection dropped" users saw on the buffered endpoint
      // WITHOUT ever leaving the app. An SSE comment is ignored by every parser and costs 2 bytes.
      const heartbeat = setInterval(() => write(': keepalive\n\n'), 5_000);
      try {
        const result = await runPlanner(messages, {
          ...deps,
          onEvent: (e: PlannerEvent) => send(e.type, e),
        });
        finish(result);
        send('result', { ...result, turn_id: turnId });
      } catch (e) {
        send('error', { error: (e as Error).message });
      } finally {
        clearInterval(heartbeat);
        if (open) { try { controller.close(); } catch { /* already closed */ } }
      }
    },
  });
  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
    },
  });
}

/** Persist a finished turn so a reconnecting client can collect it. Never fails the turn. */
function saveTurn(admin: SupabaseClient, userId: string, turnId: string, result: PlannerResult): void {
  // `messages` (the full LLM thread) is replayed by the app anyway and is the biggest part of the
  // payload — store the user-facing result only.
  const { messages: _thread, ...payload } = result as PlannerResult & { messages?: unknown };
  admin.from('plan_turns').upsert({ id: turnId, user_id: userId, result: payload })
    .then(() => {}, () => {});
}

/** Model steps in a thread (assistant turns — includes tool-calling steps). */
function countAssistant(msgs: LLMMessage[]): number {
  return msgs.filter((m) => m.role === 'assistant').length;
}

/** Integrity-check nudges in a thread (they persist across turns, so callers diff before/after). */
function countNudges(msgs: LLMMessage[]): number {
  return msgs.filter((m) => m.role === 'user' && typeof m.content === 'string' &&
    m.content.startsWith('[Integrity check')).length;
}

/** Fire-and-forget plan_turn app_event — observability must never fail or slow a turn. */
function logTurn(admin: SupabaseClient, userId: string | null, meta: Record<string, unknown>): void {
  admin.from('app_events').insert({ user_id: userId, type: 'plan_turn', metadata: meta })
    .then(() => {}, () => {});
}

/** Count the user's AI-usage events this calendar month (the free-tier budget unit). */
async function freeUsageThisMonth(admin: SupabaseClient, userId: string): Promise<number> {
  const now = new Date();
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
  const { count } = await admin.from('usage_events')
    .select('*', { count: 'exact', head: true })
    .eq('user_id', userId).gte('created_at', monthStart);
  return count ?? 0;
}

function providerKeyEnv(p: LLMProvider): string {
  if (p === 'anthropic') return 'ANTHROPIC_API_KEY';
  if (p === 'qwen') return 'QWEN_API_KEY';
  if (p === 'minimax') return 'MINIMAX_API_KEY';
  if (p === 'kimi') return 'KIMI_API_KEY';
  return 'OPENAI_API_KEY';
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
}
