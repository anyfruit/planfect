// DB- and maps-backed tool handlers + usage sink for the /plan Edge Function (Deno).
//
// SCAFFOLD: the handlers that READ are wired; the ones that WRITE the schedule have TODOs to
// finish against the live schema (deriving availability from routines + range, inserting
// time_blocks). The pure placement logic they delegate to — scheduleTask — is unit-tested
// (server/scheduling), and server/demo/planDemo.ts shows it producing real times end-to-end.

import { type SupabaseClient } from 'jsr:@supabase/supabase-js@2';
import { type ToolHandlers } from '../../../server/planner.ts';
import { type UsageEvent, type UsageSink } from '../../../server/usage.ts';
import { scheduleTask, type PlacedBlock } from '../../../server/scheduling/scheduler.ts';
import {
  planningWindowsForDate,
  zonedToUtc,
  weekdayInTz,
  type RoutineInput,
  type CalendarDate,
} from '../../../server/scheduling/routines.ts';
import { type Interval } from '../../../server/scheduling/freeSlots.ts';
import { type RoutineKind } from '../../../server/types.ts';
import {
  TOOL_GET_SCHEDULE,
  TOOL_ESTIMATE_COMMUTE,
  TOOL_GEOCODE_PLACE,
  TOOL_SCHEDULE_TASKS,
  TOOL_UPDATE_TASK,
  TOOL_WEB_SEARCH,
  TOOL_SET_ROUTINE,
  TOOL_REMEMBER_PREFERENCE,
  TOOL_SET_RECURRING,
} from '../../../server/llm/tools.ts';

export interface PlanContext {
  routines: unknown[];
  locations: LocationRow[];
  timezone: string;
  blocks: unknown[];   // upcoming time_blocks, so the planner knows the user's current plans
  homeLocationId?: string;
  workLocationId?: string;
  preferredModes: string[];   // ordered: e.g. ['transit','walking','driving']
  preferences: { id: string; text: string }[];   // learned, durable preferences (habit memory)
  observedHabits: string;     // patterns mined from the user's past schedule (soft hints)
  calendarBusy: { start: number; end: number; title: string }[];   // real device-calendar events (from the request)
  recurring: RecurringRow[];  // active recurring tasks/habits
  isPro: boolean;             // active Planfect Pro subscription (gates paid features when billing is on)
}

interface RecurringRow {
  id: string;
  title: string;
  category?: string | null;
  days_of_week: number[];
  start_local: string;
  duration_min: number;
  active: boolean;
  materialized_until?: string | null;
}

interface LocationRow {
  id: string;
  name: string;
  address?: string | null;
  lat?: number | null;
  lng?: number | null;
  place_id?: string | null;
}

export async function loadContext(supabase: SupabaseClient, userId: string): Promise<PlanContext> {
  const nowIso = new Date().toISOString();
  const pastIso = new Date(Date.now() - 60 * 86_400_000).toISOString();   // ~8 weeks back for habit mining
  const [routines, locations, profile, prefs, past, recurring] = await Promise.all([
    supabase.from('routines').select('*').eq('user_id', userId),
    supabase.from('locations').select('id,name,address,lat,lng,place_id').eq('user_id', userId),
    supabase.from('profiles').select('timezone,home_location_id,work_location_id,preferred_modes,is_pro').eq('id', userId).single(),
    supabase.from('preferences').select('id,text').eq('user_id', userId).order('created_at'),
    supabase.from('time_blocks').select('category,start_at,end_at').eq('user_id', userId)
      .eq('kind', 'task').lt('start_at', nowIso).gte('start_at', pastIso).order('start_at').limit(500),
    supabase.from('recurring_tasks').select('*').eq('user_id', userId).eq('active', true),
  ]);
  const timezone = profile.data?.timezone ?? 'UTC';

  // Keep recurring habits' occurrences filled in for the rolling horizon before reading the schedule.
  const recurringRows = (recurring.data ?? []) as RecurringRow[];
  for (const rt of recurringRows) await materializeRecurring(supabase, userId, rt, timezone);
  // Upcoming schedule from the start of today (user's tz) so the planner knows existing plans and
  // never claims the day is empty when it isn't.
  const ymd = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date()).split('-').map(Number);
  const fromUtc = new Date(zonedToUtc({ year: ymd[0], month: ymd[1], day: ymd[2] }, 0, timezone)).toISOString();
  const { data: blocks } = await supabase
    .from('time_blocks')
    .select('title,kind,status,start_at,end_at,task_id')
    .eq('user_id', userId)
    .gte('start_at', fromUtc)
    .order('start_at')
    .limit(100);
  return {
    routines: routines.data ?? [],
    locations: (locations.data ?? []) as LocationRow[],
    timezone,
    blocks: blocks ?? [],
    homeLocationId: profile.data?.home_location_id ?? undefined,
    workLocationId: profile.data?.work_location_id ?? undefined,
    preferredModes: (profile.data?.preferred_modes as string[] | undefined) ?? ['transit', 'walking', 'driving'],
    preferences: (prefs.data ?? []) as { id: string; text: string }[],
    observedHabits: summarizeHabits((past.data ?? []) as HabitRow[], timezone),
    calendarBusy: [],   // populated from the request body in index.ts
    recurring: recurringRows,
    isPro: profile.data?.is_pro ?? false,
  };
}

// --- recurring-task materialization -----------------------------------------------------

function addDays(d: CalendarDate, n: number): CalendarDate {
  const t = new Date(Date.UTC(d.year, d.month - 1, d.day) + n * 86_400_000);
  return { year: t.getUTCFullYear(), month: t.getUTCMonth() + 1, day: t.getUTCDate() };
}
function cmpDate(a: CalendarDate, b: CalendarDate): number {
  return (a.year - b.year) || (a.month - b.month) || (a.day - b.day);
}
function dateStr(d: CalendarDate): string {
  return `${d.year}-${String(d.month).padStart(2, '0')}-${String(d.day).padStart(2, '0')}`;
}

/** Create a recurring task's occurrences as time_blocks through a rolling horizon (idempotent via
 *  `materialized_until`, so a deleted occurrence is never resurrected). */
async function materializeRecurring(supabase: SupabaseClient, userId: string, rt: RecurringRow, tz: string): Promise<void> {
  if (!rt.active || !rt.days_of_week?.length) return;
  const today = localParts(Date.now(), tz).date;
  const horizon = addDays(today, 21);
  const lastDone = rt.materialized_until ? parseDate(rt.materialized_until) : null;
  let from = lastDone ? addDays(lastDone, 1) : today;
  if (cmpDate(from, today) < 0) from = today;
  if (cmpDate(from, horizon) > 0) return;   // already filled through the horizon

  const rows: Record<string, unknown>[] = [];
  for (let d = from; cmpDate(d, horizon) <= 0; d = addDays(d, 1)) {
    if (rt.days_of_week.includes(weekdayInTz(d, tz))) {
      const s = zonedToUtc(d, timeToMin(rt.start_local), tz);
      rows.push({
        user_id: userId, title: rt.title, kind: 'task', status: 'planned',
        start_at: new Date(s).toISOString(), end_at: new Date(s + (rt.duration_min ?? 60) * 60_000).toISOString(),
        category: rt.category ?? null, recurring_id: rt.id,
      });
    }
  }
  if (rows.length) await supabase.from('time_blocks').insert(rows);
  await supabase.from('recurring_tasks').update({ materialized_until: dateStr(horizon) }).eq('id', rt.id);
}

interface HabitRow { category?: string | null; start_at: string; end_at: string }

/** Mine soft habits from past task blocks: per category, the typical local start time + duration. */
function summarizeHabits(blocks: HabitRow[], tz: string): string {
  const byCat: Record<string, { mins: number[]; durs: number[] }> = {};
  for (const b of blocks) {
    const cat = b.category || 'other';
    const lp = localParts(Date.parse(b.start_at), tz);
    const dur = Math.round((Date.parse(b.end_at) - Date.parse(b.start_at)) / 60_000);
    (byCat[cat] ??= { mins: [], durs: [] });
    byCat[cat].mins.push(lp.minutes);
    byCat[cat].durs.push(dur);
  }
  const median = (a: number[]) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
  const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  const parts: string[] = [];
  for (const [cat, d] of Object.entries(byCat)) {
    if (d.mins.length < 3) continue;   // need a few samples before calling it a habit
    parts.push(`${cat}: usually ~${hhmm(median(d.mins))}, ~${median(d.durs)}min (${d.mins.length}×)`);
  }
  return parts.length ? parts.join('; ') : 'not enough history yet';
}

export function buildSystemPrompt(ctx: PlanContext): string {
  // Stable prefix first (routine/locations) for prompt-cache friendliness; the volatile
  // "today" line goes LAST so it doesn't bust the cacheable prefix.
  const now = new Date();
  const ymd = new Intl.DateTimeFormat('en-CA', {
    timeZone: ctx.timezone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now);
  const weekday = new Intl.DateTimeFormat('en-US', { timeZone: ctx.timezone, weekday: 'long' }).format(now);
  // Pre-compute the next two days so the model never has to do (and botch) the arithmetic.
  const dstamp = (d: Date) =>
    `${new Intl.DateTimeFormat('en-US', { timeZone: ctx.timezone, weekday: 'long' }).format(d)} ` +
    new Intl.DateTimeFormat('en-CA', { timeZone: ctx.timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
  const tomorrow = dstamp(new Date(now.getTime() + 86_400_000));
  const dayAfter = dstamp(new Date(now.getTime() + 2 * 86_400_000));
  return [
    'You are Planfect — a warm, sharp day-planning companion. The whole point of this app: the user',
    'fires off a quick fragment ("gym", "call dentist", "groceries sat") and you just handle it.',
    'So BE BRIEF — this matters more than anything else about your tone. Rules for EVERY reply and',
    'EVERY question you write:',
    '• Default to ONE short line. Hard ceiling: 2 short sentences. Never a paragraph.',
    '• Lead with the point in the first few words (the slot, the answer, what changed). Put any',
    '  caveat in a short trailing clause, not a sentence of its own.',
    '• Cut all filler: no "Sure!", no "I\'d be happy to", no restating their request back, no',
    '  narrating your reasoning or listing your assumptions in prose. Just the result.',
    '• A confirmation is ONE scannable line naming the TASK and its slot — "Gym today 7–8am, good? 💪"',
    '  / "买菜 周六 1:30–2:15？" Always include WHICH task, so a multi-item dump stays unambiguous;',
    '  never a windup. Match the user\'s brevity: a 3-word message gets a one-line reply.',
    'Warmth still lands in few words: a quick "nice 🎉" or a gently-real "heads up, that\'s tight"',
    'beats a cheerful paragraph. Users talk casually and briefly; never interrogate them — make smart',
    'assumptions and keep it to one quick confirmation.',
    'Always write your questions, options, and receipts in the SAME language the user wrote in.',
    `Timezone: ${ctx.timezone}.`,
    `The user's routine — schedule AROUND these by default, but they are SOFT, not hard walls: ${JSON.stringify(ctx.routines)}`,
    `Already on the user's calendar (their CURRENT plans — never say a day is empty if any fall on it): ${formatBlocks(ctx.blocks, ctx.timezone)}`,
    `The user's REAL device calendar (hard commitments — schedule AROUND these, never overlap them): ${formatCalBusy(ctx.calendarBusy, ctx.timezone)}`,
    `Saved locations: ${JSON.stringify(ctx.locations)}`,
    `LEARNED PREFERENCES — apply these every time; they reflect how THIS user likes things and override generic defaults: ${ctx.preferences.length ? ctx.preferences.map((p) => `- ${p.text} [pref:${p.id}]`).join(' ') : 'none yet'}`,
    `OBSERVED HABITS from their past schedule (soft hints, weaker than a stated preference or routine; use only when it fits): ${ctx.observedHabits}`,
    `Recurring tasks already set up (reference by id to change/stop): ${formatRecurring(ctx.recurring)}`,
    'RECURRING: when the user wants to do something REPEATEDLY on a schedule (每周一三五健身 / 每天背单词 /',
    'every Tuesday night), call set_recurring with days_of_week + start_local — do NOT create a separate',
    'one-off for each, and do NOT use set_routine (that is for work/sleep/meal background to avoid). To',
    'stop or change one, set_recurring delete by its [recurring:id]. A recurring task auto-fills the',
    'coming weeks, so just confirm it briefly.',
    'LEARN over time: when the user states a lasting preference, or corrects the same kind of choice',
    'again (e.g. keeps moving workouts to the morning, always wants 45-min grocery runs), call',
    'remember_preference(add) with a short general statement — then keep going. Do not ask permission',
    'to remember, and do not spam it for one-offs. If a preference no longer holds, remember_preference',
    '(delete) it. Priority when choosing times: explicit user request > learned preference > routine /',
    'observed habit > generic commonsense.',
    'CRITICAL — do this for EVERY task the user names, not just the examples below: first reason',
    'about when that activity naturally happens for most people, and prefer free time in THAT',
    'window. Never just grab the next open gap. Think it through — what the task involves, whether a',
    'place has to be open, business hours, social norms, the person\'s energy. Illustrations of the',
    'principle (NOT a complete list — generalize to anything):',
    '- library / errands / shopping / appointments / studying / chores -> daytime while places are open (~9:00-18:00);',
    '- workout / run / gym -> early morning (~7:00-9:00) or evening (~18:00-21:00);',
    '- a meal or coffee with someone -> a real meal time (lunch ~12:00-13:00, dinner ~18:00-20:00);',
    '- focused / deep / creative work -> morning peak hours; phone calls -> business hours unless personal;',
    '- relaxing / reading / hobbies / social -> evenings or weekends.',
    'If a task genuinely has no natural time, use sensible waking hours for this user (never the',
    'middle of the night) and keep choices coherent — no dinner at 3pm, no gym at noon on a workday.',
    'Assume sensibly: if no day is given, assume today; estimate a reasonable duration. Call',
    "get_schedule, then choose a slot that fits BOTH the free time AND the activity's natural window.",
    'If that window is already busy on the assumed day (e.g. a weekday job fills the daytime), prefer',
    'the soonest day it IS free — e.g. a weekend afternoon for a daytime outing — over cramming it',
    'into an odd hour, and name that day in your confirmation.',
    'TRAVEL TIME — for a task at a physical place (an address, venue, "across town", a saved spot):',
    'if the place is not already in Saved locations, call geocode_place first to resolve it; then call',
    'estimate_commute with from = the user\'s Home (use "home", or their Work via "work" if the task',
    'directly follows work) and to = that location, with arrive_by set to the task start. Pass the',
    'returned durationMin as commute_min to schedule_tasks so a commute + buffer are blocked off. If',
    'there is no Home saved and you cannot tell where they\'re leaving from, ask once (or skip the',
    'commute). Skip commute for at-home / virtual tasks (calls, study, chores).',
    'Routine blocks (sleep, work, meals, commute) are SOFT defaults to plan AROUND — NOT bans. Keep',
    'an AUTO / unspecified task out of them. But NEVER refuse a time the user EXPLICITLY wants just',
    'because a routine sits there — schedule it by passing start_local (the exact time) AND',
    'allow_over_routine=true. For work / meals / commute, just do it and note it lands during that',
    'block (a 3pm meeting on a workday, 摸鱼 / a day off, a dentist appointment, etc.). For SLEEP,',
    'do NOT schedule silently and do NOT refuse: first confirm ONCE via ask_user_questions, e.g.',
    'header "Heads up", question "That\'s in your sleep window (23:00–07:00) — add it anyway?", options',
    '[{label:"Yes, add it"},{label:"Pick another time"}]; only after the user says yes, schedule it',
    'with start_local + allow_over_routine=true. Never silently drop or block a time the user wants.',
    'If the user says their ROUTINE itself changed (work hours, sleep, meal times, commute, a',
    'recurring commitment), call set_routine to add/update/delete it — reference existing routines by',
    'their id — then confirm briefly. Do not create a one-off task for a routine change. If the change',
    'applies to only SOME of a routine\'s days (e.g. "Fridays I finish at 3"), SPLIT it: update the',
    'original to drop those days, then ADD a new routine for them — do not change all days at once.',
    'If the user names an external event whose real time you do not know — a match / tournament,',
    'movie showtime, concert, show, livestream, TV broadcast, store hours — call web_search to find',
    'the actual time(s), then schedule the watching/attending AT those exact times. The event may be',
    'in another timezone (e.g. a London match watched from the US): the search gives the start time',
    'BOTH in the event\'s own timezone and converted to the user\'s timezone — set start_local to the',
    'CONVERTED user-timezone time (start_local is always the user\'s local clock), NOT the event\'s home',
    'clock. Set allow_over_routine=true whenever that time overlaps a routine (work / meal / commute) —',
    'the user has chosen to watch it then, so a fixed event time wins over work. Never say you cannot',
    'look things up. If the search is inconclusive, say what you found and ask the user for the time.',
    'Be efficient: infer free days from the routine directly (a weekday job means weekends are open) —',
    'call get_schedule at most once, for the day you intend to propose. Do not keep exploring; decide',
    'and ask within a couple of tool calls.',
    'CONCURRENT activities: if the user wants to do one thing WHILE doing another (一边…一边…, "during",',
    '"at the same time as X", "while I watch the match"), do NOT find a separate free slot — schedule it',
    'at the SAME time as that activity: set start_local to that activity\'s start time and allow_overlap=true',
    'so the two sit on top of each other.',
    'EDITING existing plans: to move, resize, complete, or delete something already on the calendar, call',
    'update_task with its id (shown as [task:UUID] in the calendar list above) and the changes — e.g.',
    '{start_local:"14:00"} or {date:"2026-06-17"} to move it, {status:"done"}, {delete:true}. To SWAP or',
    'reorder two items, call update_task once for each with its new start_local. Do not delete-and-recreate',
    'when a simple move works.',
    'NEVER expose internal mechanics to the user: do not mention tool names, task ids / task_id, UUIDs,',
    '"the system", "no task_id", JSON, or how scheduling works. Those [task:…] ids are for your tool calls',
    'ONLY. Talk like a friend about the plan itself (titles, times, days) — if something cannot be done,',
    'say so plainly in human terms and offer a next step, never a technical explanation.',
    'PROPOSE then confirm — this is the core interaction. When you have ASSUMED any of {time, day,',
    'duration}, do NOT schedule yet. First call ask_user_questions with ONE short confirmation that',
    'names the concrete slot you picked. Every option needs a short description, e.g. header',
    '"Confirm", question "Gym today 3:00–5:00 PM — work for you?", options [{label:"Sounds good",',
    'description:"book it as proposed"},{label:"Pick another time",description:"I\'ll suggest another slot"}].',
    'Keep it to 2–3 options; the app always adds an "Other" free-text choice. After the user confirms, call',
    'schedule_tasks — set start_local to the agreed local time as HH:MM (24h) so it lands exactly there — then',
    'reply with a one-line receipt. If the user gave an EXPLICIT time, treat it as authoritative: set',
    'start_local to exactly that time and schedule directly (allow_over_routine=true if it overlaps',
    'work/meals — e.g. a 3pm meeting on a workday). Never shift an explicit time to a different slot.',
    'A time you PROPOSED and the user ACCEPTED is authoritative the same way: you MUST pass it as',
    'start_local (HH:MM), with allow_over_routine=true if it lands in any routine. NEVER report "no',
    'free slot" for a time the user already agreed to — pin it with start_local. If schedule_tasks',
    'still cannot place an item, do NOT claim it is scheduled: tell the user plainly it did not fit',
    'and offer to put it over the conflicting block or pick another time.',
    'Always set a category on each scheduled task (work / focus / fitness / meal / social / errand /',
    'leisure / health / learning / chore / travel / other) so the schedule shows the right type & icon.',
    'ALWAYS deliver a proposal or confirmation by calling ask_user_questions (tappable options) —',
    'never as plain text with bulleted choices, even right after a web_search.',
    'When the user answers "another time", propose a genuinely different option — a different part of',
    'the day or another day — not just a slightly later slot.',
    `Today is ${weekday}, ${ymd} (${ctx.timezone}). Tomorrow (明天) is ${tomorrow}. The day after tomorrow (后天) is ${dayAfter}.`,
    'Resolve EVERY relative date (今天/明天/后天/大后天/下周X/this Friday/this weekend) strictly by counting',
    'days from TODAY above — use the tomorrow/day-after dates given. NEVER anchor a new task\'s date to an',
    'entry already on the calendar (a "CarMax on Jun 18" already there does NOT make 后天 = Jun 18). Always',
    'state the absolute date (e.g. "Wed Jun 17") in your confirmation so the user can catch a slip.',
  ].join('\n');
}

export function buildHandlers(
  supabase: SupabaseClient,
  userId: string,
  ctx: PlanContext,
  analytics?: SupabaseClient,
  searchApiKey?: string,
  mapsApiKey?: string,
  billingEnforced = false,
): ToolHandlers {
  const routines = toRoutineInputs(ctx.routines);
  const tz = ctx.timezone;
  // Paid features (each call costs real API money) are Pro-only once billing is enforced.
  const proLocked = billingEnforced && !ctx.isPro;

  // Resolve a from/to argument (a location id, a "home"/"work" keyword, a saved place name, or a
  // raw address) to something Google Routes can take.
  const resolvePlace = (raw: string): ResolvedPlace | null => {
    const s = raw.trim();
    if (!s) return null;
    const low = s.toLowerCase();
    let id = s;
    if (low === 'home' || low === '家') id = ctx.homeLocationId ?? '';
    else if (low === 'work' || low === 'office' || low === '公司' || low === '单位') id = ctx.workLocationId ?? '';
    const byId = ctx.locations.find((l) => l.id === id);
    if (byId) return placeFromRow(byId);
    const byName = ctx.locations.find((l) => l.name.toLowerCase() === low);
    if (byName) return placeFromRow(byName);
    if (!isUuid(s)) return { address: s };   // let Routes geocode a free-text address
    return null;
  };

  return {
    [TOOL_WEB_SEARCH]: async (args) => {
      if (proLocked) return JSON.stringify({ result: 'Looking up live event times is a Planfect Pro feature. Ask the user for the time, or suggest upgrading.' });
      const query = String(args.query ?? '').trim();
      if (!query || !searchApiKey) return JSON.stringify({ result: 'Web search is unavailable.' });
      try {
        const now = new Date();
        const todayStr = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
        const weekday = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'long' }).format(now);
        const input = [
          query,
          '',
          `Context: today is ${weekday}, ${todayStr}, and the user lives in the ${tz} timezone. Resolve any relative dates ("tonight", "this Saturday", "下周六") against today, in ${tz}.`,
          '',
          'Use authoritative, current sources (the event\'s official schedule page or a well-known listing). Report, concisely:',
          '- the concrete calendar date;',
          `- the exact start time in the event's own local timezone;`,
          `- that SAME start time converted to the user's timezone (${tz}) — schedule it in ${tz}, so always include this even when the event is elsewhere;`,
          '- the source you used.',
          'If sources disagree or you cannot verify the time, say so plainly — do not guess.',
        ].join('\n');
        const res = await fetch('https://api.openai.com/v1/responses', {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${searchApiKey}` },
          body: JSON.stringify({
            model: 'gpt-4.1',
            tools: [{ type: 'web_search' }],
            input,
            max_output_tokens: 600,
          }),
        });
        const json = (await res.json()) as { output?: Array<Record<string, unknown>>; error?: { message?: string } };
        if (json.error) return JSON.stringify({ result: `Search error: ${json.error.message ?? 'unknown'}` });
        const text = (json.output ?? [])
          .filter((o) => o.type === 'message')
          .flatMap((o) => ((o.content as Array<Record<string, unknown>>) ?? [])
            .filter((c) => c.type === 'output_text')
            .map((c) => String(c.text ?? '')))
          .join('\n')
          .trim();
        return JSON.stringify({ result: text || 'No clear results found.' });
      } catch (e) {
        return JSON.stringify({ result: `Search failed: ${(e as Error).message}` });
      }
    },
    [TOOL_GET_SCHEDULE]: async (args) => {
      const start = String(args.start ?? '');
      const endRaw = String(args.end ?? '');
      const end = endRaw.includes('T') ? endRaw : `${endRaw}T23:59:59.999Z`; // include the whole end day
      const { data } = await supabase
        .from('time_blocks')
        .select('start_at,end_at,kind,title,status,task_id')
        .eq('user_id', userId)
        .gte('start_at', start)
        .lte('start_at', end)
        .order('start_at');
      return JSON.stringify(data ?? []);
    },

    [TOOL_SET_ROUTINE]: async (args) => {
      const action = String(args.action ?? '');
      const id = args.routine_id ? String(args.routine_id) : '';
      try {
        if (action === 'delete') {
          if (!id) return JSON.stringify({ ok: false, error: 'missing routine_id' });
          await supabase.from('routines').delete().eq('id', id);
          return JSON.stringify({ ok: true, action: 'deleted' });
        }
        const row: Record<string, unknown> = {};
        if (args.label !== undefined) row.label = String(args.label);
        if (args.kind !== undefined) row.kind = String(args.kind);
        if (Array.isArray(args.days_of_week)) row.days_of_week = args.days_of_week;
        if (args.start_time !== undefined) row.start_time = String(args.start_time);
        if (args.end_time !== undefined) row.end_time = String(args.end_time);
        if (action === 'update') {
          if (!id) return JSON.stringify({ ok: false, error: 'missing routine_id' });
          await supabase.from('routines').update(row).eq('id', id);
          return JSON.stringify({ ok: true, action: 'updated' });
        }
        row.user_id = userId;
        row.is_flexible = false;
        if (!row.label) row.label = row.kind ?? 'Custom';
        if (!row.days_of_week) row.days_of_week = [0, 1, 2, 3, 4, 5, 6];
        await supabase.from('routines').insert(row);
        return JSON.stringify({ ok: true, action: 'added' });
      } catch (e) {
        return JSON.stringify({ ok: false, error: (e as Error).message });
      }
    },

    // Edit an EXISTING task (referenced by the [task:…] id shown in the calendar list): move it,
    // mark it done, or delete it. Used for "change the time of X", "X is done", "swap X and Y".
    [TOOL_UPDATE_TASK]: async (args) => {
      const taskId = String(args.task_id ?? '').trim();
      const changes = (args.changes ?? {}) as Record<string, unknown>;
      if (!taskId) return JSON.stringify({ ok: false, error: 'missing task_id' });
      try {
        if (changes.delete === true || changes.status === 'cancelled') {
          await supabase.from('tasks').delete().eq('id', taskId);   // cascades its time_blocks
          return JSON.stringify({ ok: true, action: 'deleted' });
        }
        if (typeof changes.status === 'string') {
          const status = changes.status === 'done' ? 'done' : 'planned';
          await supabase.from('time_blocks').update({ status }).eq('task_id', taskId);
          await supabase.from('tasks').update({ status: changes.status }).eq('id', taskId);
          if (!changes.date && !changes.start_local) return JSON.stringify({ ok: true, action: 'status', status });
        }
        if (changes.start_local || changes.date || changes.estimated_duration_min) {
          const { data: blocks } = await supabase
            .from('time_blocks').select('id,kind,start_at,end_at').eq('task_id', taskId).order('start_at');
          const main = (blocks ?? []).find((b) => b.kind === 'task') ?? (blocks ?? [])[0];
          if (!main) return JSON.stringify({ ok: false, error: 'task has no blocks' });
          const cur = localParts(Date.parse(String(main.start_at)), tz);
          const durMin = changes.estimated_duration_min
            ? Number(changes.estimated_duration_min)
            : Math.round((Date.parse(String(main.end_at)) - Date.parse(String(main.start_at))) / 60_000);
          const date = changes.date ? parseDate(String(changes.date)) : cur.date;
          if (!date) return JSON.stringify({ ok: false, error: 'invalid date' });
          const startMin = changes.start_local ? timeToMin(String(changes.start_local)) : cur.minutes;
          const newStart = zonedToUtc(date, startMin, tz);
          const newEnd = newStart + durMin * 60_000;
          await supabase.from('time_blocks').update({
            start_at: new Date(newStart).toISOString(), end_at: new Date(newEnd).toISOString(),
          }).eq('id', main.id);
          return JSON.stringify({ ok: true, action: 'rescheduled', start: new Date(newStart).toISOString(), end: new Date(newEnd).toISOString() });
        }
        return JSON.stringify({ ok: true, action: 'noop' });
      } catch (e) {
        return JSON.stringify({ ok: false, error: (e as Error).message });
      }
    },

    // Habit memory: add/remove a durable preference. Read back into the prompt on every turn.
    [TOOL_REMEMBER_PREFERENCE]: async (args) => {
      const action = String(args.action ?? '');
      try {
        if (action === 'delete') {
          const id = args.id ? String(args.id) : '';
          if (!id) return JSON.stringify({ ok: false, error: 'missing id' });
          await supabase.from('preferences').delete().eq('id', id);
          ctx.preferences = ctx.preferences.filter((p) => p.id !== id);
          return JSON.stringify({ ok: true, action: 'deleted' });
        }
        const text = String(args.text ?? '').trim();
        if (!text) return JSON.stringify({ ok: false, error: 'missing text' });
        if (ctx.preferences.some((p) => p.text.toLowerCase() === text.toLowerCase())) {
          return JSON.stringify({ ok: true, action: 'exists' });
        }
        const { data } = await supabase.from('preferences')
          .insert({ user_id: userId, text, source: 'learned' }).select('id').single();
        const id = (data as { id: string } | null)?.id;
        if (id) ctx.preferences.push({ id, text });
        return JSON.stringify({ ok: true, action: 'added', id });
      } catch (e) {
        return JSON.stringify({ ok: false, error: (e as Error).message });
      }
    },

    // Recurring tasks/habits. add → create the rule + place upcoming occurrences now; delete → drop
    // the rule (cascade-removes its future occurrences).
    [TOOL_SET_RECURRING]: async (args) => {
      const action = String(args.action ?? '');
      try {
        if (action === 'delete') {
          const id = args.id ? String(args.id) : '';
          if (!id) return JSON.stringify({ ok: false, error: 'missing id' });
          await supabase.from('recurring_tasks').delete().eq('id', id);
          ctx.recurring = ctx.recurring.filter((r) => r.id !== id);
          return JSON.stringify({ ok: true, action: 'deleted' });
        }
        const title = String(args.title ?? '').trim();
        const days = Array.isArray(args.days_of_week) ? (args.days_of_week as number[]) : [];
        const startLocal = String(args.start_local ?? '').trim();
        if (!title || !days.length || !startLocal) {
          return JSON.stringify({ ok: false, error: 'need title, days_of_week, and start_local' });
        }
        const dur = args.estimated_duration_min ? Number(args.estimated_duration_min) : 60;
        const { data } = await supabase.from('recurring_tasks').insert({
          user_id: userId, title, category: args.category ? String(args.category) : null,
          days_of_week: days, start_local: startLocal, duration_min: dur, active: true,
        }).select('*').single();
        const row = data as RecurringRow | null;
        if (row) {
          await materializeRecurring(supabase, userId, row, tz);
          ctx.recurring.push(row);
        }
        return JSON.stringify({ ok: true, action: 'added' });
      } catch (e) {
        return JSON.stringify({ ok: false, error: (e as Error).message });
      }
    },

    [TOOL_ESTIMATE_COMMUTE]: async (args) => {
      const fromArg = String(args.from_location_id ?? '').trim();
      const toArg = String(args.to_location_id ?? '').trim();
      const arriveBy = args.arrive_by ? String(args.arrive_by) : undefined;
      const mode = ctx.preferredModes[0] ?? 'transit';
      if (proLocked) return JSON.stringify({ mode, durationMin: 25, note: 'Real travel time is a Planfect Pro feature — using a rough estimate.' });
      if (!mapsApiKey) return JSON.stringify({ mode, durationMin: 25, distanceM: 6000, note: 'maps not configured — rough estimate' });
      const from = resolvePlace(fromArg);
      const to = resolvePlace(toArg);
      if (!from || !to) {
        return JSON.stringify({ mode, durationMin: 25, note: 'could not resolve from/to — rough estimate. Ask the user for the missing address, or geocode_place it first.' });
      }
      try {
        const r = await googleRoute(mapsApiKey, from, to, mode, arriveBy);
        if (!r) return JSON.stringify({ mode, durationMin: 25, note: 'no route found — rough estimate' });
        return JSON.stringify({ mode, durationMin: r.durationMin, distanceM: r.distanceM });
      } catch (e) {
        return JSON.stringify({ mode, durationMin: 25, note: `route error (${(e as Error).message}) — rough estimate` });
      }
    },

    [TOOL_GEOCODE_PLACE]: async (args) => {
      const query = String(args.query ?? '').trim();
      if (!query) return JSON.stringify({ error: 'empty query' });
      if (!mapsApiKey) return JSON.stringify({ name: query, placeId: null, note: 'maps not configured' });
      try {
        const g = await googleGeocode(mapsApiKey, query);
        if (!g) return JSON.stringify({ name: query, placeId: null, note: 'no match found' });
        // Reuse an already-saved location for the same place rather than duplicating it.
        const existing = ctx.locations.find((l) => l.place_id && l.place_id === g.placeId);
        if (existing) {
          return JSON.stringify({ id: existing.id, name: existing.name, address: g.address, lat: g.lat, lng: g.lng, placeId: g.placeId });
        }
        const { data, error } = await supabase
          .from('locations')
          .insert({ user_id: userId, name: query, address: g.address, lat: g.lat, lng: g.lng, place_id: g.placeId })
          .select('id').single();
        if (error || !data) {
          return JSON.stringify({ name: query, address: g.address, lat: g.lat, lng: g.lng, placeId: g.placeId, note: 'resolved but not saved' });
        }
        const id = (data as { id: string }).id;
        ctx.locations.push({ id, name: query, address: g.address, lat: g.lat, lng: g.lng, place_id: g.placeId });
        return JSON.stringify({ id, name: query, address: g.address, lat: g.lat, lng: g.lng, placeId: g.placeId });
      } catch (e) {
        return JSON.stringify({ error: (e as Error).message });
      }
    },

    [TOOL_SCHEDULE_TASKS]: async (args) => {
      // Place each task on its local date around the routine + existing blocks, then persist the
      // task and its time_blocks (task + optional commute/buffer). Pure placement is scheduleTask
      // (unit-tested); availability comes from planningWindowsForDate (timezone-aware, tested).
      const tasks = (args.tasks as ScheduleTaskArg[] | undefined) ?? [];
      const items: ScheduledItem[] = [];
      const assumptions: string[] = [];

      for (const t of tasks) {
        const date = parseDate(t.date);
        if (!date) {
          items.push({ title: t.title, start: null, end: null });
          assumptions.push(`Skipped "${t.title}": missing or invalid date (expected YYYY-MM-DD).`);
          continue;
        }
        const durationMin = t.estimated_duration_min ?? DEFAULT_DURATION_MIN;
        if (!t.estimated_duration_min) assumptions.push(`Assumed ${durationMin} min for "${t.title}".`);

        const { availability, busy } = planningWindowsForDate(routines, date, tz);
        const dayBusy = await loadDayBusy(supabase, userId, date, tz);
        // Routine is a soft default. A pinned explicit time (start_local) may land ANYWHERE on the
        // day — even over sleep — so it uses a full-day window; an un-pinned task stays in the awake
        // window. When overriding routine we only avoid other already-booked tasks. The agent is
        // responsible for confirming a sleep-time placement with the user first.
        const pinned = !!t.start_local;
        const overlap = t.allow_overlap === true;
        const overRoutine = t.allow_over_routine === true || pinned;
        const window = pinned
          ? [{ start: zonedToUtc(date, 0, tz), end: zonedToUtc(date, 28 * 60, tz) }]
          : availability;
        // allow_overlap = the user wants this concurrently with another activity (一边…一边…),
        // so don't treat existing tasks as conflicts — just drop it at the requested time.
        // Real device-calendar events are hard commitments — block them even when over-routine.
        const calBusy: Interval[] = ctx.calendarBusy.map((c) => ({ start: c.start, end: c.end }));
        const blocking = overlap ? [] : (overRoutine ? [...dayBusy, ...calBusy] : [...busy, ...dayBusy, ...calBusy]);

        const placement = scheduleTask(window, blocking, {
          durationMin,
          commuteMin: t.commute_min,
          bufferMin: t.buffer_min,
          sessionMin: t.session_min,
          earliestStart: t.start_local
            ? zonedToUtc(date, timeToMin(t.start_local), tz)
            : parseWhen(t.earliest_start, tz),
          deadline: parseWhen(t.deadline, tz),
        });
        if (!placement.ok) {
          items.push({ title: t.title, start: null, end: null });
          assumptions.push(`No free slot for "${t.title}" on ${t.date}.`);
          continue;
        }

        // Persist the task first (time_blocks.task_id → tasks.id).
        const { data: taskRow, error: taskErr } = await supabase
          .from('tasks')
          .insert({
            user_id: userId,
            title: t.title,
            estimated_duration_min: durationMin,
            location_id: t.location_id ?? null,
            status: 'scheduled',
            source: 'chat',
          })
          .select('id')
          .single();
        if (taskErr || !taskRow) {
          items.push({ title: t.title, start: null, end: null });
          assumptions.push(`Could not save "${t.title}": ${taskErr?.message ?? 'insert failed'}.`);
          continue;
        }
        const taskId = (taskRow as { id: string }).id;

        const sessions = placement.blocks.filter((b) => b.kind === 'task');
        const commute = placement.blocks.find((b) => b.kind === 'commute');
        const buffer = placement.blocks.find((b) => b.kind === 'buffer');

        const rows: Record<string, unknown>[] = [];
        if (sessions.length > 1) {
          sessions.forEach((b, i) =>
            rows.push(blockRow(userId, `${t.title} (${i + 1}/${sessions.length})`, 'task', b, {
              task_id: taskId,
              location_id: t.location_id ?? null,
              category: t.category ?? null,
            })),
          );
        } else {
          rows.push(blockRow(userId, t.title, 'task', sessions[0], {
            task_id: taskId,
            location_id: t.location_id ?? null,
            category: t.category ?? null,
          }));
        }
        if (commute) {
          rows.push(blockRow(userId, `Commute to ${t.title}`, 'commute', commute, {
            task_id: taskId,
            destination_location_id: t.location_id ?? null,
            transport_mode: 'transit',
          }));
        }
        if (buffer) {
          rows.push(blockRow(userId, `Buffer after ${t.title}`, 'buffer', buffer, { task_id: taskId }));
        }

        const { error: blkErr } = await supabase.from('time_blocks').insert(rows);
        if (blkErr) {
          items.push({ title: t.title, start: null, end: null });
          assumptions.push(`Saved "${t.title}" but not its blocks: ${blkErr.message}.`);
          continue;
        }

        // Best-effort product analytics (service role bypasses RLS). Never fail the plan on it.
        if (analytics) {
          await analytics.from('app_events').insert({
            user_id: userId,
            type: 'task_scheduled',
            metadata: { task_id: taskId, title: t.title },
          });
        }

        const first = sessions[0];
        const last = sessions[sessions.length - 1];
        items.push({
          title: t.title,
          start: new Date(first.start).toISOString(),
          end: new Date(last.end).toISOString(),
          commute: commute
            ? {
                mode: 'transit',
                leaveAt: new Date(commute.start).toISOString(),
                durationMin: Math.round((commute.end - commute.start) / 60_000),
              }
            : undefined,
        });
      }

      return JSON.stringify({ items, assumptions });
    },
  };
}

export class SupabaseUsageSink implements UsageSink {
  private supabase: SupabaseClient;
  constructor(supabase: SupabaseClient) {
    this.supabase = supabase;
  }
  async record(e: UsageEvent): Promise<void> {
    await this.supabase.from('usage_events').insert({
      user_id: e.userId,
      conversation_id: e.conversationId,
      provider: e.provider,
      model: e.model,
      action: e.action,
      input_tokens: e.inputTokens,
      output_tokens: e.outputTokens,
      cached_input_tokens: e.cachedInputTokens,
      cost_usd: e.costUsd,
      latency_ms: e.latencyMs,
      success: e.success,
    });
  }
}

// ---------------------------------------------------------------------------------------
// schedule_tasks write: types + helpers
// ---------------------------------------------------------------------------------------

const DEFAULT_DURATION_MIN = 60;

interface ScheduleTaskArg {
  title: string;
  date: string; // YYYY-MM-DD, user-local
  estimated_duration_min?: number;
  start_local?: string; // HH:MM in the user's timezone
  location_id?: string | null;
  category?: string;
  commute_min?: number;
  buffer_min?: number;
  session_min?: number;
  earliest_start?: string; // ISO-8601
  deadline?: string;       // ISO-8601
  allow_over_routine?: boolean;
  allow_overlap?: boolean;
}

interface ScheduledItem {
  title: string;
  start: string | null;
  end: string | null;
  commute?: { mode: string; leaveAt: string; durationMin: number };
}

/** Map stored routine rows (DB shape) to the scheduler's RoutineInput. */
function toRoutineInputs(rows: unknown[]): RoutineInput[] {
  return (rows as Array<Record<string, unknown>>).map((r) => ({
    kind: r.kind as RoutineKind,
    daysOfWeek: (r.days_of_week as number[]) ?? [],
    startMin: timeToMin(r.start_time as string),
    endMin: timeToMin(r.end_time as string),
    isFlexible: Boolean(r.is_flexible),
  }));
}

/** 'HH:MM[:SS]' → minutes from midnight. */
function timeToMin(t: string): number {
  const [h, m] = String(t ?? '').split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
}

/**
 * Parse a datetime the model passed for earliest_start / deadline. A string with an explicit
 * zone (trailing Z or ±HH:MM) is absolute; a NAIVE "YYYY-MM-DDTHH:MM" is read as wall-clock in
 * the user's timezone — NOT UTC. (Deno's Date.parse treats naive strings as UTC, which silently
 * shifted a model-supplied local time by the tz offset and could push it into the sleep block.)
 */
function parseWhen(s: unknown, tz: string): number | undefined {
  if (typeof s !== 'string' || !s.trim()) return undefined;
  const v = s.trim();
  if (/([zZ]|[+-]\d{2}:?\d{2})$/.test(v)) return Date.parse(v);   // explicit zone → absolute
  const m = v.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/);
  if (m) return zonedToUtc({ year: +m[1], month: +m[2], day: +m[3] }, (+m[4]) * 60 + (+m[5]), tz);
  return Date.parse(v);   // date-only or unrecognized → best effort
}

/** Local Y-M-D and minutes-from-midnight of a UTC instant, in the given tz. */
function localParts(ms: number, tz: string): { date: CalendarDate; minutes: number } {
  const p = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).formatToParts(new Date(ms));
  const m: Record<string, number> = {};
  for (const x of p) if (x.type !== 'literal') m[x.type] = Number(x.value);
  return { date: { year: m.year, month: m.month, day: m.day }, minutes: m.hour * 60 + m.minute };
}

/** Compact, timezone-local summary of existing blocks for the system prompt. */
function formatBlocks(blocks: unknown[], tz: string): string {
  const list = (blocks as Array<Record<string, unknown>>) ?? [];
  if (!list.length) return 'nothing yet';
  const span = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  });
  const endf = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' });
  return list
    .map((b) => {
      const id = b.task_id ? ` [task:${String(b.task_id)}]` : '';
      return `${span.format(new Date(String(b.start_at)))}–${endf.format(new Date(String(b.end_at)))} ${String(b.title)}${b.status === 'done' ? ' (done)' : ''}${id}`;
    })
    .join('; ');
}

/** Active recurring tasks formatted for the prompt (with ids so the model can change/stop them). */
function formatRecurring(rows: RecurringRow[]): string {
  if (!rows.length) return 'none';
  const names = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  return rows
    .map((r) => `${r.title} (${r.days_of_week.map((d) => names[d]).join('/')} ${r.start_local}) [recurring:${r.id}]`)
    .join('; ');
}

/** Real device-calendar events (passed from the app) formatted for the prompt. */
function formatCalBusy(events: { start: number; end: number; title: string }[], tz: string): string {
  if (!events.length) return 'none';
  const span = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  });
  const endf = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' });
  return events.slice(0, 40)
    .map((e) => `${span.format(new Date(e.start))}–${endf.format(new Date(e.end))} ${e.title}`)
    .join('; ');
}

/** 'YYYY-MM-DD' (or the date part of an ISO datetime) → CalendarDate; null if unparseable. */
function parseDate(s: string): CalendarDate | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s ?? '').slice(0, 10));
  if (!m) return null;
  return { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) };
}

/** Existing time_blocks overlapping the user-local day, as busy intervals (epoch ms). */
async function loadDayBusy(
  supabase: SupabaseClient,
  userId: string,
  date: CalendarDate,
  tz: string,
): Promise<Interval[]> {
  const dayStart = zonedToUtc(date, 0, tz);
  const dayEnd = zonedToUtc(date, 24 * 60, tz);
  const { data } = await supabase
    .from('time_blocks')
    .select('start_at,end_at')
    .eq('user_id', userId)
    .lt('start_at', new Date(dayEnd).toISOString())
    .gt('end_at', new Date(dayStart).toISOString())
    .order('start_at');
  return ((data as Array<{ start_at: string; end_at: string }>) ?? []).map((b) => ({
    start: Date.parse(b.start_at),
    end: Date.parse(b.end_at),
  }));
}

/** Build a time_blocks insert row from a placed block. */
function blockRow(
  userId: string,
  title: string,
  kind: 'task' | 'commute' | 'buffer',
  b: PlacedBlock,
  extra: Record<string, unknown>,
): Record<string, unknown> {
  return {
    user_id: userId,
    title,
    kind,
    status: 'planned',
    start_at: new Date(b.start).toISOString(),
    end_at: new Date(b.end).toISOString(),
    ...extra,
  };
}

// ============================================================================
// Google Maps Platform — Geocoding API + Routes API (computeRoutes).
// Key comes from the GOOGLE_MAPS_API_KEY secret; absent it, the handlers above
// fall back to a rough estimate so the planner still works.
// ============================================================================

interface ResolvedPlace { address?: string; lat?: number; lng?: number }

function placeFromRow(l: LocationRow): ResolvedPlace {
  if (l.lat != null && l.lng != null) return { lat: l.lat, lng: l.lng };
  return { address: l.address ?? l.name };
}

function isUuid(s: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
}

async function googleGeocode(
  key: string,
  query: string,
): Promise<{ address: string; lat: number; lng: number; placeId: string } | null> {
  const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(query)}&key=${key}`;
  const res = await fetch(url);
  const j = await res.json() as {
    status: string;
    results?: Array<{ formatted_address: string; place_id: string; geometry: { location: { lat: number; lng: number } } }>;
  };
  const r = j.results?.[0];
  if (!r) return null;
  return { address: r.formatted_address, lat: r.geometry.location.lat, lng: r.geometry.location.lng, placeId: r.place_id };
}

const ROUTES_TRAVEL_MODE: Record<string, string> = {
  driving: 'DRIVE', transit: 'TRANSIT', walking: 'WALK', cycling: 'BICYCLE',
};

function routesWaypoint(p: ResolvedPlace): Record<string, unknown> {
  if (p.lat != null && p.lng != null) return { location: { latLng: { latitude: p.lat, longitude: p.lng } } };
  return { address: p.address };
}

async function googleRoute(
  key: string,
  from: ResolvedPlace,
  to: ResolvedPlace,
  mode: string,
  arriveBy?: string,
): Promise<{ durationMin: number; distanceM: number } | null> {
  const travelMode = ROUTES_TRAVEL_MODE[mode] ?? 'DRIVE';
  const body: Record<string, unknown> = {
    origin: routesWaypoint(from),
    destination: routesWaypoint(to),
    travelMode,
  };
  // Routes only accepts a future time. Driving uses live/predictive traffic; transit needs a time.
  const future = arriveBy && Date.parse(arriveBy) > Date.now() ? new Date(Date.parse(arriveBy)).toISOString() : undefined;
  if (travelMode === 'DRIVE') {
    body.routingPreference = 'TRAFFIC_AWARE';
    if (future) body.departureTime = future;
  } else if (travelMode === 'TRANSIT' && future) {
    body.arrivalTime = future;
  }
  const res = await fetch('https://routes.googleapis.com/directions/v2:computeRoutes', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'X-Goog-Api-Key': key,
      'X-Goog-FieldMask': 'routes.duration,routes.distanceMeters',
    },
    body: JSON.stringify(body),
  });
  const j = await res.json() as { routes?: Array<{ duration?: string; distanceMeters?: number }>; error?: { message?: string } };
  if (j.error) throw new Error(j.error.message ?? 'routes error');
  const route = j.routes?.[0];
  if (!route?.duration) return null;
  const secs = parseInt(String(route.duration), 10) || 0;   // "123s" / "123.4s" -> 123 (parseInt stops at non-digit)
  return { durationMin: Math.max(1, Math.round(secs / 60)), distanceM: route.distanceMeters ?? 0 };
}
