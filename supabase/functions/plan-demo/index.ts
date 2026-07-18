// Supabase Edge Function: POST /plan-demo  (Deno runtime) — PUBLIC, NO AUTH.
//
// Powers the interactive demo on the public showcase page. It runs the SAME planner the real app
// uses — real web search, real Google Maps travel times, real timezone-aware scheduling — but in
// DEMO mode: it writes NOTHING to any database and reads no real user's data. It operates on a
// fresh, generic context (default routine, empty calendar). So a guest gets a genuine, correct
// answer (the actual World Cup kickoff, a real transit estimate) without an account and without
// touching anyone's data — what they see is what the app would really do.
//
// Cost control: this endpoint spends real LLM/Maps money per call, so it is rate-limited per IP and
// caps input length + thread depth. All keys come from Deno.env (supabase secrets) — never the repo.
//
// Deploy:  supabase functions deploy plan-demo --no-verify-jwt --project-ref piyfhwmrumbexofbjqyu

import { createClient } from 'jsr:@supabase/supabase-js@2';
import { runPlanner } from '../../../server/planner.ts';
import { createPlanner } from '../../../server/llm/providers.ts';
import { PLANNER_TOOLS } from '../../../server/llm/tools.ts';
import { type LLMMessage, type LLMProvider } from '../../../server/llm/types.ts';
import { buildHandlers, buildSystemPrompt, SupabaseUsageSink, getPlannerConfig, type PlanContext } from '../plan/handlers.ts';

declare const Deno: { env: { get(k: string): string | undefined }; serve(h: (r: Request) => Promise<Response>): void };
declare const crypto: { subtle: { digest(algorithm: string, data: Uint8Array): Promise<ArrayBuffer> } };

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

// Best-effort per-IP guardrails. Module-level, so they reset when the isolate recycles — that's
// fine: this is a cost guardrail for the public demo, not a security boundary. Two layers:
//   • a sliding-window RATE limit (≤8/min) so nobody can hammer it fast, and
//   • a cumulative per-IP CAP that backstops the precise per-device cap the client enforces in
//     localStorage — so clearing localStorage and retrying can't trivially re-roll the allowance.
// The cap is generous (a shared IP — campus/office — has many legit guests behind it).
const HITS = new Map<string, number[]>();
const TOTAL = new Map<string, number>();
const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 8;
const MAX_PER_IP = 25;
function rateLimited(ip: string): boolean {
  const now = Date.now();
  const recent = (HITS.get(ip) ?? []).filter((t) => now - t < WINDOW_MS);
  recent.push(now);
  HITS.set(ip, recent);
  if (HITS.size > 5000) for (const [k, v] of HITS) if (v.every((t) => now - t >= WINDOW_MS)) HITS.delete(k);
  return recent.length > MAX_PER_WINDOW;
}
function overIpCap(ip: string): boolean {
  const n = (TOTAL.get(ip) ?? 0) + 1;
  TOTAL.set(ip, n);
  if (TOTAL.size > 20_000) TOTAL.clear();   // crude unbounded-growth guard for a long-lived isolate
  return n > MAX_PER_IP;
}

// A generic, believable starting point — what a brand-new user looks like before they teach the app
// anything: a default sleep/meal routine, an empty calendar, no saved places. Pro is on so paid
// tools (web search, real commutes) run, since the demo's whole job is to show them working.
function demoContext(tz: string): PlanContext {
  const everyDay = [0, 1, 2, 3, 4, 5, 6];
  return {
    routines: [
      { kind: 'sleep', days_of_week: everyDay, start_time: '23:00', end_time: '07:00', is_flexible: false },
      { kind: 'meal', days_of_week: everyDay, start_time: '12:00', end_time: '13:00', is_flexible: true },
      { kind: 'meal', days_of_week: everyDay, start_time: '18:00', end_time: '19:00', is_flexible: true },
    ],
    locations: [],
    timezone: tz,
    blocks: [],
    homeLocationId: undefined,
    workLocationId: undefined,
    preferredModes: ['transit', 'walking', 'driving'],
    preferences: [],
    observedHabits: 'none yet',
    calendarBusy: [],
    recurring: [],
    isPro: true,
  };
}

// Appended to the system prompt in demo mode only. A guest has no account and no saved places, so
// the agent must NOT pester them for profile info — it should assume sensible defaults and just plan,
// since the whole point is to show a smooth result in one shot.
const DEMO_ADDENDUM = [
  '',
  'DEMO MODE — this is a no-account public demo. The user has NO saved home/work location and you',
  'CANNOT ask for one. Never ask the user for their address, home, starting point, or to sign in,',
  'and never ask which branch of a named place — assume a representative one. If a commute would need',
  "an origin you don't have, just schedule the activities themselves (skip the commute block) rather",
  'than asking where they live. When the user gives a day-part or a couple of stops, make sensible',
  'assumptions and return ONE scheduled result (or one short confirmation) — do not interrogate.',
].join('\n');

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  try {
    if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);

    const ip = (req.headers.get('x-forwarded-for')?.split(',')[0] ?? '').trim()
      || req.headers.get('cf-connecting-ip') || 'anon';
    if (rateLimited(ip)) {
      return json({ type: 'message', text: "Demo's catching its breath — give it a few seconds and try again. 🙂" }, 429);
    }
    if (overIpCap(ip)) {
      return json({ type: 'message', text: "You've reached the demo limit for now. Download Planfect to keep planning — no limits. 🙂" }, 429);
    }

    const body = await req.json().catch(() => ({} as Record<string, unknown>));

    // Timezone comes from the browser; validate it against Intl and fall back to US Eastern.
    let tz = typeof body.tz === 'string' && body.tz ? body.tz : 'America/New_York';
    try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); } catch { tz = 'America/New_York'; }

    // Accept either a full {messages:[...]} thread or a single {text}. Keep only user/assistant
    // turns, cap each turn's length, and cap the thread depth — this is a public, paid endpoint.
    const raw = Array.isArray(body.messages) && body.messages.length
      ? (body.messages as LLMMessage[])
      : [{ role: 'user', content: String((body as { text?: unknown }).text ?? '') } as LLMMessage];
    const messages: LLMMessage[] = raw
      .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
      .slice(-12)
      .map((m) => ({ role: m.role, content: (m.content as string).slice(0, 280) }));
    if (!messages.some((m) => m.role === 'user' && (m.content as string).trim())) {
      return json({ error: 'empty message' }, 400);
    }

    // provider / model / apiKey are resolved below, after the admin client exists — they come from
    // runtime_config (surface 'demo') so the dashboard can switch the demo's model without a redeploy.

    const ctx = demoContext(tz);

    // Recency date-stamp — identical to /plan. Anchors 今天/明天/"this Saturday" (and any web-search
    // date resolution) to the real current moment in the guest's timezone, so the demo is correct.
    const nowTag = /^\[Now: .*?\]\n/;
    const nowStamp = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
      hour: 'numeric', minute: '2-digit',
    }).format(new Date());
    let stamped = false;
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m.role !== 'user' || typeof m.content !== 'string') continue;
      const base = m.content.replace(nowTag, '');
      messages[i] = {
        ...m,
        content: stamped ? base
          : `[Now: ${nowStamp} ${tz}. Resolve 今天/明天/后天/这周/dates from THIS; ignore any dates mentioned earlier in this chat.]\n${base}`,
      };
      stamped = true;
    }

    // buildHandlers requires a Supabase client, but demo mode never touches the user's data — every
    // DB-writing/reading tool is guarded by the `demo` flag. A throwaway anon client satisfies the
    // signature; web_search + estimate_commute (the tools that matter for a real answer) stay live.
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_ANON_KEY')!,
      { auth: { persistSession: false } },
    );
    // Service-role client, used ONLY for our own analytics (usage_events + demo_conversations) —
    // never for the demo's planning tools. Lets us meter demo cost and review how guests use it.
    const admin = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
      { auth: { persistSession: false } },
    );

    // Provider + model for the DEMO surface, from runtime_config (dashboard switch) → env → default.
    const cfg = await getPlannerConfig(admin, 'demo', Deno.env.get('ACTIVE_LLM_PROVIDER'), Deno.env.get('PLANNER_MODEL'));
    let provider = cfg.provider as LLMProvider;
    let model = cfg.model;
    let apiKey = Deno.env.get(providerKeyEnv(provider));
    if (!apiKey) {   // chosen provider has no key → fall back to OpenAI so the demo still works
      provider = 'openai';
      model = Deno.env.get('PLANNER_MODEL') || 'gpt-5.1-chat-latest';
      apiKey = Deno.env.get('OPENAI_API_KEY');
    }
    if (!apiKey) return json({ error: 'demo temporarily unavailable' }, 503);

    const result = await runPlanner(messages, {
      llm: createPlanner(provider, { apiKey }),
      model,
      system: buildSystemPrompt(ctx) + DEMO_ADDENDUM,
      tools: PLANNER_TOOLS,
      // demo=true (last arg): real placement + web search + commutes, but no writes to user data.
      handlers: buildHandlers(
        supabase, 'demo', ctx, undefined,
        Deno.env.get('OPENAI_API_KEY'), Deno.env.get('GOOGLE_MAPS_API_KEY'), false, true,
      ),
      context: { userId: 'demo' },
      // Meter the demo's token/cost into usage_events, tagged source='demo' (user_id is null).
      usage: new SupabaseUsageSink(admin, 'demo'),
      maxSteps: 8,
    });

    // Persist the conversation for the author to review (anonymous; IP hashed, not raw). Best-effort —
    // a logging failure must never break the demo response.
    try {
      const cleaned = messages
        .filter((m) => (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
        .map((m) => ({ role: m.role, content: (m.content as string).replace(nowTag, '') }));
      const r = result as { type?: string };
      await admin.from('demo_conversations').insert({
        ip_hash: await sha256Hex(ip).then((h) => h.slice(0, 16)),
        tz,
        model,
        result_type: r.type ?? 'unknown',
        turns: cleaned.filter((m) => m.role === 'user').length,
        messages: cleaned,
        result,
      });
    } catch (_) { /* analytics is best-effort */ }

    return json(result);
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }
});

/** SHA-256 hex of a string — used to hash the visitor IP so the raw address is never stored. */
async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function providerKeyEnv(p: LLMProvider): string {
  if (p === 'anthropic') return 'ANTHROPIC_API_KEY';
  if (p === 'qwen') return 'QWEN_API_KEY';
  if (p === 'minimax') return 'MINIMAX_API_KEY';
  if (p === 'kimi') return 'KIMI_API_KEY';
  return 'OPENAI_API_KEY';
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { ...CORS, 'content-type': 'application/json' } });
}
