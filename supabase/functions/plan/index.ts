// Supabase Edge Function: POST /plan  (Deno runtime).
// Wires the unit-tested server/ modules to Supabase Auth + Postgres + a maps/LLM provider.
//
// DEPLOY-TIME code — it imports Deno/Supabase and is NOT run by the Node unit tests (those
// cover the pure logic via MockPlanner). For a runnable end-to-end walkthrough on Node, see
// server/demo/planDemo.ts. Deploy with: supabase functions deploy plan

import { createClient, type SupabaseClient } from 'jsr:@supabase/supabase-js@2';
import { runPlanner } from '../../../server/planner.ts';
import { createPlanner } from '../../../server/llm/providers.ts';
import { PLANNER_TOOLS } from '../../../server/llm/tools.ts';
import { type LLMMessage, type LLMProvider } from '../../../server/llm/types.ts';
import { buildHandlers, loadContext, buildSystemPrompt, SupabaseUsageSink, getPlannerConfig } from './handlers.ts';

declare const Deno: { env: { get(k: string): string | undefined }; serve(h: (r: Request) => Promise<Response>): void };

Deno.serve(async (req: Request): Promise<Response> => {
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
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return json({ error: 'unauthorized' }, 401);

    const body = await req.json();
    const conversationId: string | undefined = body.conversation_id;
    const messages: LLMMessage[] = body.messages ?? [{ role: 'user', content: String(body.text ?? '') }];

    // Provider + model come from runtime_config (the dashboard's model switcher, surface 'app'),
    // falling back to env then a default. If the chosen provider has no key configured, fall back to
    // OpenAI so a misconfigured switch never hard-fails the planner.
    const cfg = await getPlannerConfig(admin, 'app', Deno.env.get('ACTIVE_LLM_PROVIDER'), Deno.env.get('PLANNER_MODEL'));
    let provider = cfg.provider as LLMProvider;
    let model = cfg.model;
    let apiKey = Deno.env.get(providerKeyEnv(provider));
    if (!apiKey) {
      provider = 'openai';
      model = Deno.env.get('PLANNER_MODEL') || 'gpt-5.1-chat-latest';
      apiKey = Deno.env.get('OPENAI_API_KEY');
    }

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

    const result = await runPlanner(messages, {
      llm: createPlanner(provider, { apiKey: apiKey ?? '' }),
      model,
      system: buildSystemPrompt(ctx),
      tools: PLANNER_TOOLS,
      handlers: buildHandlers(supabase, user.id, ctx, admin, Deno.env.get('OPENAI_API_KEY'), Deno.env.get('GOOGLE_MAPS_API_KEY'), billingEnforced),
      context: { userId: user.id, conversationId },
      usage: new SupabaseUsageSink(admin),
      maxSteps: 14,
    });

    // NOTE (Phase 2): also persist `messages` into the `messages` table here so the
    // conversation + clarifying-question state survives across the ask -> answer round trip.
    return json(result);
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }
});

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
  return 'OPENAI_API_KEY';
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
}
