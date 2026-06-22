// Prompt eval harness (Deno). Drives the REAL planner (buildSystemPrompt + PLANNER_TOOLS + runPlanner,
// demo mode) over a fixed scenario suite and scores each result against an expected behavior, so prompt
// changes are MEASURED (pass-rate per version) instead of eyeballed. Deterministic: a pinned `now`.
//
// Run (model from env; defaults to MiniMax-M2.7-highspeed):
//   set -a; source ~/.planfect-deploy.env; set +a
//   EVAL_PROVIDER=minimax EVAL_MODEL=MiniMax-M2.7-highspeed \
//     deno run --allow-net --allow-env server/eval/promptEval.ts
//
// To eval the production model, set EVAL_PROVIDER=openai EVAL_MODEL=gpt-5.1-chat-latest (needs OPENAI_API_KEY).

import { createClient } from 'jsr:@supabase/supabase-js@2';
import { runPlanner, type PlannerResult } from '../planner.ts';
import { createPlanner } from '../llm/providers.ts';
import { PLANNER_TOOLS } from '../llm/tools.ts';
import { type LLMMessage, type LLMProvider } from '../llm/types.ts';
import { buildHandlers, buildSystemPrompt, type PlanContext } from '../../supabase/functions/plan/handlers.ts';

declare const Deno: { env: { get(k: string): string | undefined }; exit(c?: number): never };

const TZ = 'America/New_York';
const NOW = new Date('2026-06-22T02:00:00Z');   // pinned: Sunday 2026-06-21, 22:00 ET
const TODAY = '2026-06-21', TOMORROW = '2026-06-22', DAYAFTER = '2026-06-23';

// A generic, account-less context — same shape the public demo uses (default routine, empty calendar).
function demoContext(): PlanContext {
  const everyDay = [0, 1, 2, 3, 4, 5, 6];
  return {
    routines: [
      { kind: 'sleep', days_of_week: everyDay, start_time: '23:00', end_time: '07:00', is_flexible: false },
      { kind: 'meal', days_of_week: everyDay, start_time: '12:00', end_time: '13:00', is_flexible: true },
      { kind: 'meal', days_of_week: everyDay, start_time: '18:00', end_time: '19:00', is_flexible: true },
    ],
    locations: [], timezone: TZ, blocks: [], homeLocationId: undefined, workLocationId: undefined,
    preferredModes: ['transit', 'walking', 'driving'], preferences: [], observedHabits: 'none yet',
    calendarBusy: [], recurring: [], isPro: true,
  };
}

const nowStamp = new Intl.DateTimeFormat('en-US', {
  timeZone: TZ, weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit',
}).format(NOW);
function messageFor(text: string): LLMMessage[] {
  return [{ role: 'user', content: `[Now: ${nowStamp} ${TZ}. Resolve 今天/明天/后天/这周/dates from THIS; ignore any dates mentioned earlier in this chat.]\n${text}` }];
}

/** Local Y-M-D + hour of an ISO instant, in TZ. */
function parts(iso: string | null | undefined): { date: string; hour: number; min: number } | null {
  if (!iso) return null;
  const p = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(iso));
  const m: Record<string, string> = {};
  for (const x of p) if (x.type !== 'literal') m[x.type] = x.value;
  return { date: `${m.year}-${m.month}-${m.day}`, hour: Number(m.hour), min: Number(m.minute) };
}
const items = (r: PlannerResult) => (r.type === 'scheduled' ? r.receipt.items : []);
const hoursOf = (r: PlannerResult) => items(r).map((i) => parts(i.start)?.hour).filter((h): h is number => h != null);

interface Scenario { name: string; text: string; note: string; check: (r: PlannerResult) => string[] }

const SCENARIOS: Scenario[] = [
  {
    name: 'explicit-time-passed', text: '下午3点跟老板开个会',
    note: 'explicit 3pm (already past at 10pm) → schedule tomorrow 15:00, do NOT ask',
    check: (r) => {
      if (r.type !== 'scheduled') return [`expected scheduled, got ${r.type}`];
      const p = parts(items(r)[0]?.start); const f: string[] = [];
      if (!p) return ['no start time'];
      if (p.hour !== 15) f.push(`hour ${p.hour}≠15`);
      if (p.date !== TOMORROW) f.push(`date ${p.date}≠${TOMORROW}`);
      return f;
    },
  },
  {
    name: 'tentative-hold', text: '我28号要吃个fine dining，但还没想好是哪家',
    note: 'undecided venue → block a tentative evening hold on the 28th (not a question)',
    check: (r) => {
      if (r.type !== 'scheduled') return [`expected scheduled, got ${r.type}`];
      const p = parts(items(r)[0]?.start); const f: string[] = [];
      if (!p) return ['no start time'];
      if (p.date !== '2026-06-28') f.push(`date ${p.date}≠2026-06-28`);
      if (p.hour < 17 || p.hour > 21) f.push(`hour ${p.hour} not an evening dinner slot`);
      return f;
    },
  },
  {
    name: 'multitask-batch', text: '明天上午十点开会，下午两点看牙，晚上七点健身',
    note: 'brain-dump → one batch of 3, correct times (10/14/19), all tomorrow',
    check: (r) => {
      if (r.type !== 'scheduled') return [`expected scheduled, got ${r.type}`];
      const f: string[] = [];
      if (items(r).length !== 3) f.push(`${items(r).length} items ≠ 3`);
      const hs = hoursOf(r);
      for (const h of [10, 14, 19]) if (!hs.includes(h)) f.push(`missing an item at hour ${h}`);
      for (const it of items(r)) { const p = parts(it.start); if (p && p.date !== TOMORROW) f.push(`an item on ${p.date}≠${TOMORROW}`); }
      return f;
    },
  },
  {
    name: 'natural-run-no-time', text: '帮我安排跑步',
    note: 'no time → a natural running window (morning 6-9 / evening 18-21), or ask',
    check: (r) => {
      if (r.type === 'questions') return [];
      if (r.type !== 'scheduled') return [`expected scheduled or questions, got ${r.type}`];
      const h = hoursOf(r)[0];
      return (h != null && ((h >= 6 && h <= 9) || (h >= 18 && h <= 21))) ? [] : [`hour ${h} not a natural run window`];
    },
  },
  {
    name: 'daypart-afternoon', text: '下午健身',
    note: 'day-part given → schedule in the afternoon (12-18), do NOT re-ask which part',
    check: (r) => {
      if (r.type !== 'scheduled') return [`expected scheduled, got ${r.type} (day-part was given)`];
      const h = hoursOf(r)[0];
      return (h != null && h >= 12 && h < 18) ? [] : [`hour ${h} not afternoon`];
    },
  },
  {
    name: 'explicit-tomorrow-evening', text: '明天晚上8点看电影',
    note: 'explicit tomorrow 20:00 → schedule exactly there',
    check: (r) => {
      if (r.type !== 'scheduled') return [`expected scheduled, got ${r.type}`];
      const p = parts(items(r)[0]?.start); const f: string[] = [];
      if (!p) return ['no start time'];
      if (p.hour !== 20) f.push(`hour ${p.hour}≠20`);
      if (p.date !== TOMORROW) f.push(`date ${p.date}≠${TOMORROW}`);
      return f;
    },
  },
  {
    name: 'vague-should-ask', text: '随便找个时间聊聊天',
    note: 'genuinely vague (no day/time/who) → SHOULD ask, not auto-schedule',
    check: (r) => (r.type === 'questions' ? [] : [`expected questions, got ${r.type}`]),
  },
  {
    name: 'sleep-confirm', text: '今晚凌晨两点学习',
    note: '2am is in the sleep window → confirm once before scheduling',
    check: (r) => (r.type === 'questions' ? [] : [`expected questions (sleep confirm), got ${r.type}`]),
  },
  {
    name: 'relative-day-after', text: '后天中午12点和朋友吃饭',
    note: '后天 = day-after (6/23), noon → schedule there',
    check: (r) => {
      if (r.type !== 'scheduled') return [`expected scheduled, got ${r.type}`];
      const p = parts(items(r)[0]?.start); const f: string[] = [];
      if (!p) return ['no start time'];
      if (p.date !== DAYAFTER) f.push(`date ${p.date}≠${DAYAFTER}`);
      if (p.hour !== 12) f.push(`hour ${p.hour}≠12`);
      return f;
    },
  },
  {
    name: 'concurrent-overlap', text: '明天晚上八点一边跑步一边追剧',
    note: '一边…一边… → place at 20:00 tomorrow (concurrently), schedule it',
    check: (r) => {
      if (r.type !== 'scheduled') return [`expected scheduled, got ${r.type}`];
      const at20 = items(r).some((i) => { const p = parts(i.start); return p && p.hour === 20 && p.date === TOMORROW; });
      return at20 ? [] : ['nothing scheduled at 20:00 tomorrow'];
    },
  },
];

// ---- run ----
const PROVIDER = (Deno.env.get('EVAL_PROVIDER') ?? 'minimax') as LLMProvider;
const MODEL = Deno.env.get('EVAL_MODEL') ?? 'MiniMax-M2.7-highspeed';
const KEYENV: Record<string, string> = { openai: 'OPENAI_API_KEY', anthropic: 'ANTHROPIC_API_KEY', qwen: 'QWEN_API_KEY', minimax: 'MINIMAX_API_KEY' };
const apiKey = Deno.env.get(KEYENV[PROVIDER]);
if (!apiKey) { console.error(`Missing ${KEYENV[PROVIDER]} for provider ${PROVIDER}`); Deno.exit(1); }

const supabase = createClient(Deno.env.get('SUPABASE_URL') ?? 'http://localhost', Deno.env.get('SUPABASE_ANON_KEY') ?? 'anon', { auth: { persistSession: false } });
const ctx = demoContext();
const system = buildSystemPrompt(ctx, NOW);
const llm = createPlanner(PROVIDER, { apiKey });
const handlers = buildHandlers(supabase, 'eval', ctx, undefined, undefined, undefined, false, true);

console.log(`\nPrompt eval — ${PROVIDER}:${MODEL} — pinned now = ${nowStamp} ${TZ} (today ${TODAY})\n`);
let passed = 0;
for (const s of SCENARIOS) {
  let r: PlannerResult | null = null;
  let failures: string[];
  try {
    r = await runPlanner(messageFor(s.text), { llm, model: MODEL, system, tools: PLANNER_TOOLS, handlers, context: { userId: 'eval' }, maxSteps: 8 });
    failures = s.check(r);
  } catch (e) { failures = [`threw: ${(e as Error).message}`]; }
  const ok = failures.length === 0;
  if (ok) passed++;
  console.log(`${ok ? '✅' : '❌'} ${s.name.padEnd(24)} ${ok ? '' : '— ' + failures.join('; ')}`);
  if (!ok && r) {
    if (r.type === 'scheduled') for (const it of r.receipt.items) console.log(`        • ${it.title} @ ${it.start}`);
    if (r.type === 'questions') console.log(`        ? ${r.questions.map((q) => q.question).join(' | ')}`);
    if (r.type === 'message') console.log(`        💬 ${r.text.slice(0, 120)}`);
  }
}
console.log(`\n${passed}/${SCENARIOS.length} passed  (${PROVIDER}:${MODEL})\n`);
