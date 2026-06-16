// Supabase Edge Function: POST /plan  (Deno runtime).
// Wires the unit-tested server/ modules to Supabase Auth + Postgres + a maps/LLM provider.
//
// DEPLOY-TIME code — it imports Deno/Supabase and is NOT run by the Node unit tests (those
// cover the pure logic via MockPlanner). For a runnable end-to-end walkthrough on Node, see
// server/demo/planDemo.ts. Deploy with: supabase functions deploy plan

import { createClient } from 'jsr:@supabase/supabase-js@2';
import { runPlanner } from '../../../server/planner.ts';
import { createPlanner } from '../../../server/llm/providers.ts';
import { PLANNER_TOOLS } from '../../../server/llm/tools.ts';
import { type LLMMessage, type LLMProvider } from '../../../server/llm/types.ts';
import { buildHandlers, loadContext, buildSystemPrompt, SupabaseUsageSink } from './handlers.ts';

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

    // Provider + model are config (switch OpenAI / Anthropic / Qwen without code changes).
    const provider = (Deno.env.get('ACTIVE_LLM_PROVIDER') ?? 'openai') as LLMProvider;
    const model = Deno.env.get('PLANNER_MODEL') ?? 'gpt-5.4';
    const apiKey = Deno.env.get(providerKeyEnv(provider))!;

    const ctx = await loadContext(supabase, user.id);
    // Real device-calendar events the app passes in, so the planner schedules around them.
    ctx.calendarBusy = ((body.calendar_busy ?? []) as Array<{ start: string; end: string; title?: string }>)
      .map((c) => ({ start: Date.parse(c.start), end: Date.parse(c.end), title: String(c.title ?? 'Busy') }))
      .filter((c) => Number.isFinite(c.start) && Number.isFinite(c.end) && c.end > c.start);
    const result = await runPlanner(messages, {
      llm: createPlanner(provider, { apiKey }),
      model,
      system: buildSystemPrompt(ctx),
      tools: PLANNER_TOOLS,
      handlers: buildHandlers(supabase, user.id, ctx, admin, Deno.env.get('OPENAI_API_KEY'), Deno.env.get('GOOGLE_MAPS_API_KEY')),
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

function providerKeyEnv(p: LLMProvider): string {
  if (p === 'anthropic') return 'ANTHROPIC_API_KEY';
  if (p === 'qwen') return 'QWEN_API_KEY';
  return 'OPENAI_API_KEY';
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
}
