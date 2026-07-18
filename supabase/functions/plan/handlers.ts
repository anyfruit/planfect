// DB- and maps-backed tool handlers + usage sink for the /plan Edge Function (Deno).
//
// SCAFFOLD: the handlers that READ are wired; the ones that WRITE the schedule have TODOs to
// finish against the live schema (deriving availability from routines + range, inserting
// time_blocks). The pure placement logic they delegate to — scheduleTask — is unit-tested
// (server/scheduling), and server/demo/planDemo.ts shows it producing real times end-to-end.

import { type SupabaseClient } from 'jsr:@supabase/supabase-js@2';
import { sendPush } from '../_shared/apns.ts';
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
  closeFriends: { id: string; username: string; name: string }[];   // friends who let the user add to THEIR calendar (close)
  regularFriends: { id: string; username: string; name: string }[]; // accepted friends who have NOT made the user close
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

export async function loadContext(supabase: SupabaseClient, userId: string, admin?: SupabaseClient): Promise<PlanContext> {
  const nowIso = new Date().toISOString();
  const pastIso = new Date(Date.now() - 60 * 86_400_000).toISOString();   // ~8 weeks back for habit mining
  const fdb = admin ?? supabase;
  const [routines, locations, profile, prefs, past, recurring, friendEdgesRes] = await Promise.all([
    supabase.from('routines').select('*').eq('user_id', userId),
    supabase.from('locations').select('id,name,address,lat,lng,place_id').eq('user_id', userId),
    supabase.from('profiles').select('timezone,home_location_id,work_location_id,preferred_modes,is_pro').eq('id', userId).single(),
    supabase.from('preferences').select('id,text').eq('user_id', userId).order('created_at'),
    supabase.from('time_blocks').select('category,start_at,end_at').eq('user_id', userId)
      .eq('kind', 'task').lt('start_at', nowIso).gte('start_at', pastIso).order('start_at').limit(500),
    supabase.from('recurring_tasks').select('*').eq('user_id', userId).eq('active', true),
    // Friend edges don't depend on anything above — fetch them in the same round-trip. Reading a
    // friend's profile needs the service role (the user's client is RLS-limited to their own row).
    fdb.from('friendships').select('owner_id, tier').eq('friend_id', userId).eq('status', 'accepted'),
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
    .select('id,title,kind,status,start_at,end_at,task_id,recurring_id,tz')
    .eq('user_id', userId)
    .gte('start_at', fromUtc)
    .order('start_at')
    .limit(100);
  // Accepted friends, keyed by the tier THEY grant me (their edge: owner=them, friend=me). 'close'
  // lets me add a plan to their calendar; 'friend' (regular) does not.
  const friendEdges = friendEdgesRes.data;
  const tierByFriend = new Map<string, string>();
  for (const e of (friendEdges ?? []) as { owner_id: string; tier: string }[]) tierByFriend.set(e.owner_id, e.tier);
  const closeFriends: { id: string; username: string; name: string }[] = [];
  const regularFriends: { id: string; username: string; name: string }[] = [];
  if (tierByFriend.size) {
    const { data: fps } = await fdb
      .from('profiles').select('id,username,display_name').in('id', [...tierByFriend.keys()]);
    for (const p of ((fps ?? []) as { id: string; username: string | null; display_name: string | null }[])) {
      if (!p.username) continue;
      const entry = { id: p.id, username: p.username, name: p.display_name || p.username };
      (tierByFriend.get(p.id) === 'close' ? closeFriends : regularFriends).push(entry);
    }
  }

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
    closeFriends,
    regularFriends,
  };
}

// --- runtime model config (dashboard-driven) --------------------------------------------

export type PlannerSurface = 'app' | 'demo';
export interface PlannerChoice { provider: string; model: string }

// Cache the runtime_config read per surface for a few seconds, so a dashboard switch lands quickly
// without a DB round-trip on every request. Module-level → shared across requests in a warm isolate.
const _plannerCfgCache = new Map<PlannerSurface, { v: PlannerChoice; at: number }>();
const PLANNER_CFG_TTL_MS = 20_000;

/** Resolve the active provider/model for a surface from runtime_config (written by the dashboard's
 *  model switcher), falling back to env (ACTIVE_LLM_PROVIDER / PLANNER_MODEL) then a safe default.
 *  A DB error never breaks planning — it falls back. */
export async function getPlannerConfig(
  admin: SupabaseClient,
  surface: PlannerSurface,
  envProvider?: string,
  envModel?: string,
): Promise<PlannerChoice> {
  const fallback: PlannerChoice = {
    provider: envProvider || 'openai',
    model: envModel || 'gpt-5.1-chat-latest',
  };
  const cached = _plannerCfgCache.get(surface);
  if (cached && Date.now() - cached.at < PLANNER_CFG_TTL_MS) return cached.v;
  try {
    const { data } = await admin
      .from('runtime_config')
      .select('key,value')
      .in('key', [`planner_provider_${surface}`, `planner_model_${surface}`]);
    const m = new Map((data ?? []).map((r: { key: string; value: string }) => [r.key, r.value]));
    const v: PlannerChoice = {
      provider: m.get(`planner_provider_${surface}`) || fallback.provider,
      model: m.get(`planner_model_${surface}`) || fallback.model,
    };
    _plannerCfgCache.set(surface, { v, at: Date.now() });
    return v;
  } catch {
    return fallback;
  }
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

/** Create a recurring task's occurrences as time_blocks through a rolling horizon. INVARIANT:
 *  days ≤ `materialized_until` are NEVER regenerated, so an occurrence the user deleted or moved
 *  (block-scope update_task) stays deleted/moved — do not "backfill gaps" here. */
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

export function buildSystemPrompt(ctx: PlanContext, now: Date = new Date()): string {
  // Stable prefix first (routine/locations) for prompt-cache friendliness; the volatile
  // "today" line goes LAST so it doesn't bust the cacheable prefix. `now` is injectable so the
  // prompt-eval harness can pin a deterministic "today" (defaults to the real current time).
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
  // Anchor the Mon–Sun week arithmetic too: models botch 下周X/再下周X on boundary days (esp.
  // Sunday), so hand them the concrete Mondays to count from instead of a convention to reason out.
  const dowIdx = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
    .indexOf(new Intl.DateTimeFormat('en-US', { timeZone: ctx.timezone, weekday: 'short' }).format(now));
  const daysToNextMon = ((8 - dowIdx) % 7) || 7;   // Sun→1, Mon→7, Tue→6, … (next week's Monday)
  const nextMon = dstamp(new Date(now.getTime() + daysToNextMon * 86_400_000));
  const monAfter = dstamp(new Date(now.getTime() + (daysToNextMon + 7) * 86_400_000));
  return [
    'You are Planfect — a warm, sharp day-planning companion. The user fires quick fragments ("gym",',
    '"call dentist", "买菜 sat") and you just handle them. BE BRIEF — above all else:',
    '• ONE short line by default; hard cap 2 short sentences, never a paragraph. Lead with the point',
    '  (the slot / answer / what changed); caveats go in a trailing clause.',
    '• No filler ("Sure!", "I\'d be happy to"), no restating their request, no narrated reasoning.',
    '• A confirmation is ONE scannable line naming the TASK and its slot — "Gym today 7–8am, good? 💪"',
    '  / "买菜 周六 1:30–2:15？". Match the user\'s brevity.',
    'Warmth in few words ("nice 🎉", "heads up, that\'s tight"). Never interrogate — make smart',
    'assumptions, one quick confirmation. Always write in the SAME language the user wrote in.',
    'BOUNDARIES — strictly a friendly day-planning assistant. NEVER use profanity, insults, slurs, or',
    'mockery (not even echoing the user\'s); do NOT produce hateful, harassing, violent, sexual,',
    'self-harm, illegal, anti-social, or political / anti-government content, and never take a',
    'political side. If asked for any of that (or abused): don\'t argue — decline in ONE warm line and',
    'steer back to planning ("这个我帮不上忙哈 🙂 想安排点什么吗？"). Stay kind even to rude users.',
    `Timezone: ${ctx.timezone} — where the user IS right now. Every clock time below, and every time the user says, is ALREADY on this zone's clock.`,
    'NEVER convert or shift a clock time the user gives: "3pm" / "晚上10点" means exactly that on this',
    'zone\'s clock — pass it verbatim as start_local (HH:MM, 24h). A remark like "我说的是 LA 时间" only',
    'names WHICH zone, never a cue for arithmetic; storing 21:00 for a stated 22:00 is a serious error.',
    'PER-EVENT timezone: leave schedule_tasks.timezone UNSET (server uses this zone) — ONLY set an IANA',
    'zone when pre-planning for somewhere the user is NOT yet (booking next week\'s NYC trip from home →',
    'America/New_York). Each plan keeps its own zone forever, so its wall-clock never drifts.',
    `The user's routine — schedule AROUND these by default, but they are SOFT, not hard walls: ${JSON.stringify(ctx.routines)}`,
    `Already on the user's calendar (their CURRENT plans — never say a day is empty if any fall on it): ${formatBlocks(ctx.blocks, ctx.timezone)}`,
    `The user's REAL device calendar (hard commitments — schedule AROUND these, never overlap them): ${formatCalBusy(ctx.calendarBusy, ctx.timezone)}`,
    `Saved locations: ${JSON.stringify(ctx.locations)}`,
    `LEARNED PREFERENCES — apply these every time; they reflect how THIS user likes things and override generic defaults: ${ctx.preferences.length ? ctx.preferences.map((p) => `- ${p.text} [pref:${p.id}]`).join(' ') : 'none yet'}`,
    `OBSERVED HABITS from their past schedule (soft hints, weaker than a stated preference or routine; use only when it fits): ${ctx.observedHabits}`,
    `Recurring tasks already set up (reference by id to change/stop): ${formatRecurring(ctx.recurring)}`,
    `CLOSE FRIENDS — you CAN add a shared plan to their calendar: ${ctx.closeFriends.length ? ctx.closeFriends.map((f) => `@${f.username} (${f.name})`).join(', ') : 'none'}`,
    `OTHER FRIENDS — accepted, but they have NOT made you close, so you canNOT add to their calendar yet: ${ctx.regularFriends.length ? ctx.regularFriends.map((f) => `@${f.username} (${f.name})`).join(', ') : 'none'}`,
    'WITH A FRIEND ("和 @sam 吃饭", "dinner with Alex"): if ONE close friend is a confident match, set',
    'with_friends=[username] so it lands on BOTH calendars. Vague ("和朋友") or unmatchable → do NOT',
    'guess: ask_user_questions "和哪位好友一起？" with the CLOSE FRIENDS as options (multi_select=true),',
    'then schedule with the chosen usernames. If they meant an OTHER (non-close) friend, schedule for',
    'the user alone + one line that the friend must set them close first.',
    'RECURRING (每周一三五健身 / every Tuesday night): call set_recurring with days_of_week +',
    'start_local — NOT one-offs per week, NOT set_routine (that is background like work/sleep/meals).',
    'Stop/change via set_recurring delete by [recurring:id]. It auto-fills coming weeks; confirm briefly.',
    'LEARN: when the user states a lasting preference or repeats the same correction, call',
    'remember_preference(add) with a short general statement (delete it if it stops holding) — no',
    'permission-asking, no one-offs. Priority: explicit request > learned preference > routine /',
    'observed habit > generic commonsense.',
    'CRITICAL — for EVERY task: first think when that activity NATURALLY happens (what it involves,',
    'opening hours, social norms, energy) and prefer free time in THAT window — never just the next',
    'open gap. Guide (generalize): errands/appointments/studying → daytime ~9-18; workout → ~7-9 or',
    '~18-21; meals/coffee → real meal times (lunch ~12-13, dinner ~18-20); deep work → morning; calls →',
    'business hours; leisure/social → evenings/weekends. No natural time → sensible waking hours, and',
    'keep choices coherent (no dinner at 3pm, no gym at noon on a workday).',
    'Assume sensibly: no day given → today; estimate a reasonable duration. The upcoming calendar above',
    'has exact times — read it directly; do NOT call get_schedule for a day already shown (slow extra',
    'round-trip), only for uncovered days. If the natural window is busy that day (weekday job fills',
    'daytime), prefer the soonest day it IS free (e.g. weekend afternoon) over an odd hour — name that day.',
    'TRAVEL TIME — task at a physical place: geocode_place it if not in Saved locations, then',
    'estimate_commute from "home" (or "work" if it directly follows work), arrive_by = task start.',
    'MODE matches how they\'ll travel: "driving" for airport runs / long hops / implied car (车程 /',
    '开车), else their default. Pass durationMin as commute_min AND the same mode as transport_mode to',
    'schedule_tasks (blocks the commute + right icon). No Home and origin unclear → ask once or skip.',
    'Skip commute for at-home / virtual tasks.',
    'CRITICAL — start_local is when the ACTIVITY starts (arrival / appointment / showtime), NEVER the',
    'departure time. Do NOT subtract travel yourself: pass the activity time + commute_min and the',
    'scheduler lays the commute BEFORE it ("eat at 7:30", 15-min drive → start_local 19:30,',
    'commute_min 15 → leave 19:15). Never shift the activity later than the stated time.',
    'CATCHING A FLIGHT / TRAIN / FERRY: the stated time is DEPARTURE, not when to leave home — get',
    'them there EARLY: 1) lead time to BE there = domestic flight ~90 min (~120 busy hub/bags),',
    'international ~150–180, train/ferry/bus ~20–30; judge domestic vs international from the two',
    'endpoints (PVD → LAX = both US = domestic). 2) estimate_commute home → airport/station, mode',
    '"driving", arrive_by = departure − lead. 3) Schedule ONE task (category travel, title like "去 TF',
    'Green 赶 19:00 飞 LA 的航班") with start_local = departure − lead, estimated_duration_min = lead,',
    'commute_min = the drive, transport_mode "driving" — e.g. 19:00 domestic flight, 15-min drive →',
    'start_local 17:30, duration 90, commute 15 → leave 17:15. Confirm only if you assumed something.',
    'Routines (sleep, work, meals, commute) are SOFT defaults to plan AROUND — not bans. Keep AUTO /',
    'unspecified tasks out of them, but NEVER refuse a time the user EXPLICITLY wants: pass start_local',
    '+ allow_over_routine=true. Over work/meals/commute just do it and note it ("3pm meeting on a',
    'workday"). Over SLEEP: neither silently schedule nor refuse — confirm ONCE via ask_user_questions',
    '("That\'s in your sleep window (23:00–07:00) — add it anyway?" → [Yes, add it / Pick another',
    'time]), then schedule with start_local + allow_over_routine=true.',
    'If the ROUTINE itself changed (work hours, sleep, meals, commute), call set_routine',
    'add/update/delete (reference by id) and confirm briefly — never a one-off task for it. A change on',
    'only SOME days ("Fridays I finish at 3") → SPLIT: update the original to drop those days + ADD a',
    'new routine for them.',
    'External event with a real time you don\'t know (match, showtime, concert, livestream, store',
    'hours) → web_search for the actual time, then schedule AT it. The search reports the time in the',
    'event\'s zone AND converted to the user\'s — use the CONVERTED one as start_local, with',
    'allow_over_routine=true if it overlaps a routine (a fixed event time beats work). Never say you',
    'can\'t look things up; if inconclusive, say what you found and ask.',
    'Be FAST — latency is a feature. You almost always have everything above to place a task with NO',
    'get_schedule call: emit independent tool calls together in one step, never explore, reach',
    'schedule_tasks / ask_user_questions in as few steps as possible.',
    'CONCURRENT (一边…一边…, "while I watch the match"): no separate slot — SCHEDULE it (schedule_tasks)',
    'at the SAME time: start_local = that activity\'s start, allow_overlap=true, so they sit on top of',
    'each other.',
    'EDITING existing plans: to move, resize, complete, or delete something already on the calendar, call',
    'update_task with its id (shown as [task:UUID] in the calendar list above) and the changes — e.g.',
    '{start_local:"14:00"} or {date:"2026-06-17"} to move it, {status:"done"}, {delete:true}. To SWAP or',
    'reorder two items, call update_task once for each with its new start_local. Do not delete-and-recreate',
    'when a simple move works.',
    'A [block:UUID] tag marks ONE occurrence of a recurring habit (or a plan a friend shared): pass that',
    'id to update_task the same way to move / complete / cancel JUST that occurrence — the habit itself',
    'and all other weeks stay ("下周三健身取消" / "把明天的健身挪到晚上" = a [block:…] edit). To stop or',
    'change the WHOLE habit, use set_recurring (delete by its [recurring:id]) — never delete occurrences',
    'one by one for that.',
    'IDS GO STALE: the ONLY ids valid right now are the [task:UUID] / [block:UUID] tags in the calendar',
    'list ABOVE and any task_id returned by a tool THIS turn. This chat spans many days — an id quoted in',
    'an EARLIER turn (including your own old tool calls) may no longer exist; never reuse one. If',
    'update_task fails, its result includes current_tasks with the live ids (task_id or block_id — pass',
    'whichever is present) — pick the right one and retry IMMEDIATELY in this same turn. NEVER tell the',
    'user something was changed or deleted unless the tool actually returned ok:true; if it keeps failing,',
    'say plainly that it did not work — do not invent reasons like missing permissions, and do not claim',
    'it is already at the requested time unless the calendar list shows it.',
    'THE SYSTEM IS NEVER DOWN. Tools always respond; there is no outage, maintenance, or "系统没有反应".',
    'NEVER refuse with 加不了/改不动/系统故障/等恢复/"not responding"/"try later", never tell the user to',
    'wait or resend, and never carry over a refusal from earlier in this chat — each new message is a',
    'fresh request: CALL the tool. The ONLY honest failure is a tool result from THIS turn saying so.',
    'FIXING A MISTAKE ("为什么排到X", "不对", "改到…", "时间错了"): ACT immediately — if the correct',
    'slot is clear, update_task and confirm in one line; if you truly need their call, offer tappable',
    'options via ask_user_questions ("改到今天 14:00?" → [可以 / 换个时间]). NEVER ask them to re-type /',
    'resend a command in plain text.',
    'A CORRECTION TARGETS THE ITEM NAMED ("我的意思是日料三点吃", "the meeting is actually at 4"):',
    'update THAT item — never shuffle others around it leaving it at the old time. If one message moves',
    'an ANCHOR plus dependents ("日料三点吃，吃完再去逛街"): FIRST move the anchor, THEN place each',
    'dependent relative to the anchor\'s NEW time.',
    'AFTER / BEFORE another item ("吃完再…", "before my call"): anchor on its ACTUAL calendar time —',
    '"after X" → earliest_start = X\'s real END; "before X" → deadline = X\'s real START. No guessed',
    'clock times, no overlapping X; if X also moves this turn, compute from X\'s NEW time. Never claim',
    '"right after X" unless it truly starts at X\'s end.',
    'BULK EDITS ("把所有日程平移一小时", "clear tomorrow"): just DO it — update_task once per affected',
    'item from the list above. NEVER refuse with "没法一键" or push work back; iterating IS the job. Too',
    'many to handle at once → change the ones shown, say how many remain, offer to continue.',
    'NEVER expose internals: no tool names, ids/UUIDs, "the system", JSON, or how scheduling works —',
    '[task:…]/[block:…] ids are for tool calls ONLY. Talk like a friend about the plan (titles, times,',
    'days); if something can\'t be done, say it plainly in human terms + a next step.',
    'MANY THINGS AT ONCE (a brain-dump: "明天上午开会，下午看牙，晚上健身再看个电影"): do NOT confirm',
    'one by one — assume smartly for ALL and schedule the whole set in ONE schedule_tasks call → ONE',
    'tap-to-edit receipt. If one item is truly unplaceable, schedule the rest and flag just that one.',
    'BIAS TO ACT: when a message names a task plus ANY rough when — a day, a day-part, "this',
    'weekend", an explicit time — the correct response is a schedule_tasks CALL that places it, not a',
    'plain chat reply and not a question. Chatting back about a plan without scheduling it is a miss.',
    'A DAY-PART is NOT vague — 上午/中午/下午/晚上, morning / tonight, "after work", "this weekend"',
    'GIVE you the window: pick a concrete slot inside it and CALL schedule_tasks NOW — the tap-to-edit',
    'receipt IS the confirmation (one line only if you assumed something). A stated day-part OVERRIDES',
    'the activity\'s natural window (下午健身 → 12:00–17:59, even though gym is usually evening). NEVER',
    'ask "上午还是下午?" / "今天还是明天?" / "3–4点可以吗?" when they named it, and never re-ask',
    'ANYTHING already stated — re-asking given information is the single worst miss here.',
    'AN UNDECIDED DETAIL (which restaurant / gym / exact title) is NOT a question and NOT a reason to',
    'schedule nothing: CALL schedule_tasks to BLOCK A TENTATIVE HOLD at the activity\'s natural time on',
    'the given day, titled for it ("Dinner — spot TBD" / "Fine dining (待定)"), no commute while the',
    'place is unknown, and say in one line it\'s a hold ("先占了28号晚7点，定好餐厅再调 🙂"). Only ASK',
    'when you can\'t tell even roughly WHEN, or whether they want it on the calendar at all.',
    'PROPOSE then confirm — for a SINGLE task ONLY when you had to ASSUME the TIME or DAY ("sometime",',
    '"this week", nothing given): don\'t schedule yet; ask_user_questions with ONE confirmation naming',
    'the slot ("Gym today 3:00–5:00 PM — work for you?" → 2–3 options, each with a short description;',
    'the app adds "Other" itself). On confirm, schedule with start_local = the agreed HH:MM. If only the',
    'DURATION is a guess, schedule with a sensible default — never ask "how long?"; the receipt is',
    'tap-to-edit.',
    'An EXPLICIT time is authoritative: start_local = exactly that, allow_over_routine=true if it',
    'overlaps work/meals; never shift it. Explicit time with NO day = the obvious next occurrence',
    '(today, or tomorrow if already past per [Now]) — schedule and NAME the day ("跟老板开会 明天 15:00',
    '✅"), don\'t ask. A day-part with no day works the same: soonest day that window still fits.',
    '(Reserve questions for when even the rough WHEN is missing — "随便找个时间".)',
    'A time you PROPOSED and the user ACCEPTED is authoritative too: pass it as start_local with',
    'allow_over_routine=true if needed — NEVER report "no free slot" for an agreed time. If',
    'schedule_tasks still can\'t place it, say plainly it didn\'t fit and offer to overlap or move it —',
    'do NOT claim it is scheduled.',
    'Always set a category (work / focus / fitness / meal / social / errand / leisure / health /',
    'learning / chore / travel / other) so the schedule shows the right icon.',
    'ALWAYS deliver proposals/confirmations via ask_user_questions (tappable) — never plain-text',
    'bulleted choices, even right after a web_search. When the user answers "another time", propose a',
    'genuinely different option (another part of day / another day), not a slightly later slot.',
    `Today is ${weekday}, ${ymd} (${ctx.timezone}). Tomorrow (明天) is ${tomorrow}. The day after tomorrow (后天) is ${dayAfter}.`,
    `Weeks run MONDAY–Sunday. NEXT week (下周) starts ${nextMon}; the week AFTER next (再下周 / 下下周)`,
    `starts ${monAfter}. So 下周X = that weekday in the week starting ${nextMon}, and 再下周X = that`,
    `weekday in the week starting ${monAfter} — count from these anchors, NEVER re-derive the week`,
    'yourself (on a Sunday the current week ends TODAY: 下周三 is only 3 days away, 再下周三 is 10).',
    '这周X / this Xday = that weekday inside the current Mon–Sun week. Always state the absolute date',
    'in your confirmation so the user can catch a mis-count.',
    'This "Today" date is GROUND TRUTH and matches the [Now: …] stamp on the latest user message.',
    'This conversation may span MULTIPLE real days: earlier turns (and any date THEY mention, or any',
    'date in an existing calendar entry) can be from previous days — NEVER infer the current date from',
    'them. Resolve EVERY relative date (今天/明天/后天/大后天/下周X/this Friday/this weekend) strictly by',
    'counting days from the Today date above — never from a date that appears earlier in the chat or on',
    'the calendar (a "CarMax on Jun 18" already there does NOT make 后天 = Jun 18; an old turn that said',
    '"6月15日" does NOT make today Jun 15). When scheduling 今天, the date you pass MUST equal Today above.',
    'Always state the absolute date (e.g. "Wed Jun 17") in your confirmation so the user can catch a slip.',
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
  demo = false,
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
    if (!isUuid(s)) return looksLikePlaceId(s) ? { placeId: s } : { address: s };   // placeId vs free-text address
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
      if (demo) return JSON.stringify(ctx.blocks ?? []);   // demo has no persisted schedule
      const start = String(args.start ?? '');
      const endRaw = String(args.end ?? '');
      const end = endRaw.includes('T') ? endRaw : `${endRaw}T23:59:59.999Z`; // include the whole end day
      const { data } = await supabase
        .from('time_blocks')
        .select('id,start_at,end_at,kind,title,status,task_id,recurring_id')
        .eq('user_id', userId)
        .gte('start_at', start)
        .lte('start_at', end)
        .order('start_at');
      return JSON.stringify(data ?? []);
    },

    [TOOL_SET_ROUTINE]: async (args) => {
      if (demo) return JSON.stringify({ ok: true });
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
    // Every write verifies the DB error AND the affected-row count — PostgREST reports a no-match
    // update/delete as a bland success, which used to let the model tell the user a change landed
    // when nothing did. Any failure returns the LIVE task list so the model can retry with a real
    // id in the same loop: ids quoted from old chat turns go stale, and a multi-week thread is full
    // of them. Each attempt is also logged to app_events so the next "can't change it" report is
    // diagnosable from data.
    [TOOL_UPDATE_TASK]: async (args) => {
      if (demo) return JSON.stringify({ ok: true, action: 'noop' });
      // Tolerate decorated ids ("task:…", "[task:…]", "[block:…]") and a `changes` that arrived
      // double-encoded as a JSON string — both otherwise turn a valid edit into a silent no-op.
      const taskId = String(args.task_id ?? '').trim().replace(/^\[?(task|block):/i, '').replace(/\]$/, '');
      const changes = parseChanges(args.changes);
      const result = await applyTaskUpdate(supabase, userId, tz, taskId, changes);
      if (analytics) {
        try {
          await analytics.from('app_events').insert({
            user_id: userId, type: 'planner_update_task',
            metadata: { task_id: taskId, changes, result: JSON.parse(result) },
          });
        } catch { /* observability must never break the edit */ }
      }
      return result;
    },

    // Habit memory: add/remove a durable preference. Read back into the prompt on every turn.
    [TOOL_REMEMBER_PREFERENCE]: async (args) => {
      if (demo) return JSON.stringify({ ok: true });
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
      if (demo) return JSON.stringify({ ok: true, action: 'added' });
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
      // Use the mode the model asked for (driving for an airport run, etc.); fall back to the
      // user's preferred mode when it didn't specify one.
      const mode = normalizeMode(args.mode) ?? ctx.preferredModes[0] ?? 'transit';
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
        if (demo) return JSON.stringify({ name: query, address: g.address, lat: g.lat, lng: g.lng, placeId: g.placeId });
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
        // Mode for the commute block + receipt: what the model said it'd travel by, else the
        // user's preferred mode. Drives the receipt label and the transport_mode column/icon.
        const commuteMode = normalizeMode(t.transport_mode) ?? ctx.preferredModes[0] ?? 'transit';
        // The timezone this task's wall-clock belongs to: the per-task override the model set for a
        // trip, else the session's planning tz (the device's current zone). start_local/date are read
        // in THIS zone and it is stored on every block so the app always renders the planned clock time.
        const taskTz = safeTimezone(t.timezone, tz);

        const { availability, busy } = planningWindowsForDate(routines, date, taskTz);
        const dayBusy = demo ? [] : await loadDayBusy(supabase, userId, date, taskTz);
        // Routine is a soft default. A pinned explicit time (start_local) may land ANYWHERE on the
        // day — even over sleep — so it uses a full-day window; an un-pinned task stays in the awake
        // window. When overriding routine we only avoid other already-booked tasks. The agent is
        // responsible for confirming a sleep-time placement with the user first.
        const pinned = !!t.start_local;
        const overlap = t.allow_overlap === true;
        const overRoutine = t.allow_over_routine === true || pinned;
        const window = pinned
          ? [{ start: zonedToUtc(date, 0, taskTz), end: zonedToUtc(date, 28 * 60, taskTz) }]
          : availability;
        // allow_overlap = the user wants this concurrently with another activity (一边…一边…),
        // so don't treat existing tasks as conflicts — just drop it at the requested time.
        // Real device-calendar events are hard commitments — block them even when over-routine.
        const calBusy: Interval[] = ctx.calendarBusy.map((c) => ({ start: c.start, end: c.end }));
        const blocking = overlap ? [] : (overRoutine ? [...dayBusy, ...calBusy] : [...busy, ...dayBusy, ...calBusy]);

        const placement = scheduleTask(window, blocking, {
          durationMin,
          commuteMin: t.commute_min != null ? clampCommuteMin(Number(t.commute_min)) : undefined,
          bufferMin: t.buffer_min,
          sessionMin: t.session_min,
          // An explicit start_local is the time the task itself should START (you arrive/begin then);
          // pass it as pinnedStart so any commute is laid down BEFORE it. Otherwise it's just a soft
          // "not before" bound.
          pinnedStart: t.start_local ? zonedToUtc(date, timeToMin(t.start_local), taskTz) : undefined,
          earliestStart: t.start_local ? undefined : parseWhen(t.earliest_start, taskTz),
          deadline: parseWhen(t.deadline, taskTz),
        });
        if (!placement.ok) {
          items.push({ title: t.title, start: null, end: null });
          assumptions.push(`No free slot for "${t.title}" on ${t.date}.`);
          continue;
        }

        // Demo mode: the placement is REAL (same timezone-aware engine), but nothing is persisted —
        // build the receipt item straight from the computed blocks and move on. No DB writes.
        if (demo) {
          const ss = placement.blocks.filter((b) => b.kind === 'task');
          const cm = placement.blocks.find((b) => b.kind === 'commute');
          items.push({
            title: t.title,
            start: new Date(ss[0].start).toISOString(),
            end: new Date(ss[ss.length - 1].end).toISOString(),
            tz: taskTz,
            commute: cm
              ? { mode: commuteMode, leaveAt: new Date(cm.start).toISOString(), durationMin: clampCommuteMin((cm.end - cm.start) / 60_000) }
              : undefined,
          });
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
              tz: taskTz,
            })),
          );
        } else {
          rows.push(blockRow(userId, t.title, 'task', sessions[0], {
            task_id: taskId,
            location_id: t.location_id ?? null,
            category: t.category ?? null,
            tz: taskTz,
          }));
        }
        if (commute) {
          rows.push(blockRow(userId, `Commute to ${t.title}`, 'commute', commute, {
            task_id: taskId,
            destination_location_id: t.location_id ?? null,
            transport_mode: commuteMode,
            tz: taskTz,
          }));
        }
        if (buffer) {
          rows.push(blockRow(userId, `Buffer after ${t.title}`, 'buffer', buffer, { task_id: taskId, tz: taskTz }));
        }

        // Collaborative double-booking: if the user named a CLOSE friend, stamp a shared id on the
        // task block(s) and mirror them into that friend's own calendar (linked by shared_event_id).
        const wanted = (t.with_friends ?? []).map((w) => String(w).replace(/^@/, '').toLowerCase());
        const friends = wanted
          .map((w) => ctx.closeFriends.find((f) => f.username.toLowerCase() === w || f.name.toLowerCase() === w))
          .filter((f): f is { id: string; username: string; name: string } => !!f);
        const sharedId = friends.length ? crypto.randomUUID() : undefined;
        if (sharedId) for (const r of rows) if (r.kind === 'task') r.shared_event_id = sharedId;

        const { error: blkErr } = await supabase.from('time_blocks').insert(rows);
        if (blkErr) {
          items.push({ title: t.title, start: null, end: null });
          assumptions.push(`Saved "${t.title}" but not its blocks: ${blkErr.message}.`);
          continue;
        }

        // Mirror into EACH chosen close friend's calendar — needs the service role, since writing
        // another user's rows and reading their push tokens is blocked by RLS for the user's client.
        const friendWriter = analytics ?? supabase;
        for (const friend of friends) {
          const friendRows = rows
            .filter((r) => r.kind === 'task')
            .map((r) => ({
              user_id: friend.id, title: r.title as string, kind: 'task', status: 'planned',
              start_at: r.start_at as string, end_at: r.end_at as string,
              category: (r.category as string | null) ?? null, shared_event_id: sharedId,
              tz: taskTz,
            }));
          const { error: fErr } = await friendWriter.from('time_blocks').insert(friendRows);
          if (fErr) {
            assumptions.push(`Couldn't add to ${friend.name}'s calendar: ${fErr.message}.`);
          } else {
            assumptions.push(`Also added to ${friend.name}'s calendar.`);
            await notifyScheduledWith(friendWriter, friend.id, userId, t.title).catch(() => {});
          }
        }

        // Best-effort product analytics (service role bypasses RLS). Fire-and-forget: never fail
        // the plan on it, and never make the user wait a round-trip for a metric.
        if (analytics) {
          analytics.from('app_events').insert({
            user_id: userId,
            type: 'task_scheduled',
            metadata: { task_id: taskId, title: t.title },
          }).then(() => {}, () => {});
        }

        const first = sessions[0];
        const last = sessions[sessions.length - 1];
        items.push({
          title: t.title,
          task_id: taskId,   // so a follow-up edit THIS turn can update_task without re-reading the calendar
          start: new Date(first.start).toISOString(),
          end: new Date(last.end).toISOString(),
          tz: taskTz,
          commute: commute
            ? {
                mode: commuteMode,
                leaveAt: new Date(commute.start).toISOString(),
                durationMin: clampCommuteMin((commute.end - commute.start) / 60_000),
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
  private source: string;
  // source tags where the call came from: 'app' (the signed-in planner) or 'demo' (the public web demo).
  constructor(supabase: SupabaseClient, source = 'app') {
    this.supabase = supabase;
    this.source = source;
  }
  async record(e: UsageEvent): Promise<void> {
    await this.supabase.from('usage_events').insert({
      user_id: isUuid(e.userId) ? e.userId : null,   // the demo has no real user → null
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
      source: this.source,
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
  timezone?: string;    // IANA tz this task's clock time is in; defaults to the session planning tz
  estimated_duration_min?: number;
  start_local?: string; // HH:MM in the task's timezone
  location_id?: string | null;
  category?: string;
  commute_min?: number;
  transport_mode?: string;
  buffer_min?: number;
  session_min?: number;
  earliest_start?: string; // ISO-8601
  deadline?: string;       // ISO-8601
  allow_over_routine?: boolean;
  allow_overlap?: boolean;
  with_friends?: string[];   // usernames (no @) of close friends to double-book this plan with
}

interface ScheduledItem {
  title: string;
  task_id?: string;   // persisted task id — lets a same-turn follow-up edit call update_task directly
  start: string | null;
  end: string | null;
  tz?: string;   // IANA tz the item's clock time is in, so the receipt renders the planned wall-clock
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

/** Validate a model/client-supplied IANA timezone; fall back to `fallback` if missing or bogus.
 *  Keeps a hallucinated zone (or a city name the model passed) from corrupting time math. */
function safeTimezone(tz: unknown, fallback: string): string {
  const s = String(tz ?? '').trim();
  if (!s) return fallback;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: s });
    return s;
  } catch {
    return fallback;
  }
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

/** The nested `changes` object occasionally arrives double-encoded as a JSON string (provider
 *  quirk); parse it rather than silently treating the whole edit as empty. */
function parseChanges(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, unknown>;
  if (typeof raw === 'string' && raw.trim().startsWith('{')) {
    try { return JSON.parse(raw) as Record<string, unknown>; } catch { /* fall through */ }
  }
  return {};
}

/** The user's task blocks from yesterday onward (live ids + local times). Attached to every failed
 *  update_task so the model can pick the RIGHT id and retry in the same loop instead of dead-ending
 *  on an id it mis-copied or quoted from an earlier day's turn. */
async function listUpcomingTasks(supabase: SupabaseClient, userId: string, sessionTz: string): Promise<unknown[]> {
  const from = new Date(Date.now() - 86_400_000).toISOString();
  const { data } = await supabase
    .from('time_blocks')
    .select('id,task_id,recurring_id,title,start_at,tz,status')
    .eq('user_id', userId).eq('kind', 'task')
    .gte('start_at', from).order('start_at').limit(25);
  return ((data ?? []) as Array<Record<string, unknown>>)
    .map((b) => {
      const btz = safeTimezone(b.tz, sessionTz);
      const fmt = new Intl.DateTimeFormat('en-CA', {
        timeZone: btz, year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
      });
      return {
        // One-off plans are addressed by task_id; a recurring occurrence / shared block by its
        // OWN block id — pass whichever is present as update_task's task_id.
        ...(b.task_id
          ? { task_id: b.task_id }
          : { block_id: b.id, ...(b.recurring_id ? { recurring_occurrence: true } : {}) }),
        title: b.title, status: b.status,
        start_local: fmt.format(new Date(String(b.start_at))), timezone: btz,
      };
    });
}

/** Apply an update_task edit with honest reporting: ok:true ONLY when rows actually changed; every
 *  failure carries `current_tasks` (live ids) so the model self-corrects. See the handler comment. */
async function applyTaskUpdate(
  supabase: SupabaseClient,
  userId: string,
  sessionTz: string,
  taskId: string,
  changes: Record<string, unknown>,
): Promise<string> {
  const fail = async (error: string) => JSON.stringify({
    ok: false, error,
    current_tasks: await listUpcomingTasks(supabase, userId, sessionTz).catch(() => []),
    hint: 'Retry NOW with the correct task_id from current_tasks. Do not tell the user it worked unless ok:true.',
  });
  if (!isUuid(taskId)) {
    return await fail(`"${taskId}" is not an id — pass the exact UUID from a [task:…] or [block:…] tag`);
  }
  try {
    // Resolve the id: first as a task id (one-off plans — may own satellite commute/buffer blocks),
    // else as a SINGLE block id (a recurring occurrence or a friend-shared block, which have no
    // tasks row). Block scope edits exactly one row and leaves the recurring rule untouched.
    let scope: 'task' | 'block' = 'task';
    const byTask = await supabase
      .from('time_blocks').select('id,kind,title,start_at,end_at,tz')
      .eq('task_id', taskId).eq('user_id', userId).order('start_at');
    if (byTask.error) return await fail(`lookup failed: ${byTask.error.message}`);
    let blocks = byTask.data ?? [];
    if (!blocks.length) {
      const byBlock = await supabase
        .from('time_blocks').select('id,kind,title,start_at,end_at,tz')
        .eq('id', taskId).eq('user_id', userId);
      if (byBlock.error) return await fail(`lookup failed: ${byBlock.error.message}`);
      blocks = byBlock.data ?? [];
      scope = 'block';
    }
    if (!blocks.length) {
      return await fail('no task or calendar item with that id — ids from earlier chat turns may be stale');
    }
    const title0 = String(blocks[0].title ?? '');

    if (changes.delete === true || changes.status === 'cancelled') {
      if (scope === 'block') {
        // Remove just this occurrence. The recurring rule stays, and materializeRecurring never
        // re-creates a day it already covered (materialized_until), so it won't resurrect.
        const del = await supabase.from('time_blocks').delete()
          .eq('id', String(blocks[0].id)).eq('user_id', userId).select('id');
        if (del.error) return await fail(`delete failed: ${del.error.message}`);
        if (!del.data?.length) return await fail('delete matched nothing');
        return JSON.stringify({ ok: true, action: 'deleted', scope: 'single occurrence', title: title0 });
      }
      // tasks.delete cascades the blocks; sweep any block without a tasks row (legacy/mirrored)
      // and confirm SOMETHING was actually removed before reporting the deletion.
      const del = await supabase.from('tasks').delete().eq('id', taskId).eq('user_id', userId).select('id');
      if (del.error) return await fail(`delete failed: ${del.error.message}`);
      const sweep = await supabase.from('time_blocks').delete().eq('task_id', taskId).eq('user_id', userId).select('id');
      if (sweep.error && !del.data?.length) return await fail(`delete failed: ${sweep.error.message}`);
      if (!(del.data?.length || sweep.data?.length)) return await fail('delete matched nothing');
      return JSON.stringify({ ok: true, action: 'deleted', title: title0 });
    }

    let renamed: string | undefined;
    if (typeof changes.title === 'string' && changes.title.trim()) {
      const newTitle = changes.title.trim();
      if (scope === 'task') {
        const t = await supabase.from('tasks').update({ title: newTitle }).eq('id', taskId).eq('user_id', userId).select('id');
        if (t.error) return await fail(`rename failed: ${t.error.message}`);
      }
      const b = scope === 'task'
        ? await supabase.from('time_blocks').update({ title: newTitle })
          .eq('task_id', taskId).eq('user_id', userId).eq('kind', 'task').select('id')
        : await supabase.from('time_blocks').update({ title: newTitle })
          .eq('id', String(blocks[0].id)).eq('user_id', userId).select('id');
      if (b.error) return await fail(`rename failed: ${b.error.message}`);
      if (!b.data?.length) return await fail('rename matched nothing');
      renamed = newTitle;
    }

    if (typeof changes.status === 'string') {
      const status = changes.status === 'done' ? 'done' : 'planned';
      const b = scope === 'task'
        ? await supabase.from('time_blocks').update({ status }).eq('task_id', taskId).eq('user_id', userId).select('id')
        : await supabase.from('time_blocks').update({ status }).eq('id', String(blocks[0].id)).eq('user_id', userId).select('id');
      if (b.error) return await fail(`status update failed: ${b.error.message}`);
      if (!b.data?.length) return await fail('status update matched nothing');
      if (scope === 'task') {
        await supabase.from('tasks').update({ status: changes.status }).eq('id', taskId).eq('user_id', userId);
      }
      if (!changes.date && !changes.start_local && !changes.estimated_duration_min && !changes.timezone) {
        return JSON.stringify({ ok: true, action: 'status', status, title: renamed ?? title0 });
      }
    }

    if (changes.start_local || changes.date || changes.estimated_duration_min || changes.timezone) {
      const main = blocks.find((b) => b.kind === 'task') ?? blocks[0];
      // Interpret the (existing or new) wall-clock in the block's own timezone — keeps a trip
      // event in its trip zone — unless the change explicitly moves it to another zone.
      const blockTz = safeTimezone(changes.timezone, (main.tz as string | null) ?? sessionTz);
      const cur = localParts(Date.parse(String(main.start_at)), blockTz);
      const durMin = changes.estimated_duration_min
        ? Number(changes.estimated_duration_min)
        : Math.round((Date.parse(String(main.end_at)) - Date.parse(String(main.start_at))) / 60_000);
      const date = changes.date ? parseDate(String(changes.date)) : cur.date;
      if (!date) return await fail(`invalid date "${changes.date}" — expected YYYY-MM-DD`);
      if (changes.start_local !== undefined && !/^([01]?\d|2[0-3]):[0-5]\d$/.test(String(changes.start_local).trim())) {
        return await fail(`invalid start_local "${changes.start_local}" — expected HH:MM (24h)`);
      }
      const startMin = changes.start_local ? timeToMin(String(changes.start_local).trim()) : cur.minutes;
      const newStart = zonedToUtc(date, startMin, blockTz);
      const newEnd = newStart + durMin * 60_000;
      const upd = await supabase.from('time_blocks').update({
        start_at: new Date(newStart).toISOString(), end_at: new Date(newEnd).toISOString(), tz: blockTz,
      }).eq('id', main.id).eq('user_id', userId).select('id');
      if (upd.error) return await fail(`move failed: ${upd.error.message}`);
      if (!upd.data?.length) return await fail('move matched nothing');
      // Move the satellite blocks WITH the task so they stay contiguous (otherwise a moved task
      // strands its old commute/buffer on the calendar): commute keeps its length and ends at the
      // new start; buffer keeps its length and begins at the new end.
      for (const b of blocks) {
        if (b.id === main.id) continue;
        const len = Date.parse(String(b.end_at)) - Date.parse(String(b.start_at));
        const s = b.kind === 'commute' ? newStart - len : b.kind === 'buffer' ? newEnd : null;
        if (s == null) continue;
        await supabase.from('time_blocks').update({
          start_at: new Date(s).toISOString(), end_at: new Date(s + len).toISOString(), tz: blockTz,
        }).eq('id', b.id).eq('user_id', userId);
      }
      return JSON.stringify({
        ok: true, action: 'rescheduled', title: renamed ?? title0,
        ...(scope === 'block' ? { scope: 'single occurrence' } : {}),
        start: new Date(newStart).toISOString(), end: new Date(newEnd).toISOString(), timezone: blockTz,
      });
    }

    if (renamed) return JSON.stringify({ ok: true, action: 'renamed', title: renamed });
    return await fail(
      "nothing to apply — pass changes like {start_local:'HH:MM'}, {date:'YYYY-MM-DD'}, {estimated_duration_min:90}, {status:'done'}, or {delete:true}",
    );
  } catch (e) {
    return await fail((e as Error).message);
  }
}

/** Compact summary of existing blocks for the system prompt. Each block is shown in ITS OWN stored
 *  timezone (falling back to the session tz for legacy rows), with a short zone hint when it differs
 *  from the session tz — so the model reads each plan at the wall-clock the user actually sees. */
function formatBlocks(blocks: unknown[], tz: string): string {
  const list = (blocks as Array<Record<string, unknown>>) ?? [];
  if (!list.length) return 'nothing yet';
  return list
    .map((b) => {
      const btz = safeTimezone(b.tz, tz);
      const span = new Intl.DateTimeFormat('en-US', {
        timeZone: btz, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
      });
      const endf = new Intl.DateTimeFormat('en-US', { timeZone: btz, hour: 'numeric', minute: '2-digit' });
      // Task-backed blocks carry [task:…]; blocks WITHOUT a tasks row (a recurring occurrence, a
      // plan a friend shared in) carry [block:…] so the model can still edit/delete that ONE item.
      const id = b.task_id ? ` [task:${String(b.task_id)}]` : b.id ? ` [block:${String(b.id)}]` : '';
      const zone = btz !== tz ? ` (${btz})` : '';
      return `${span.format(new Date(String(b.start_at)))}–${endf.format(new Date(String(b.end_at)))}${zone} ${String(b.title)}${b.status === 'done' ? ' (done)' : ''}${id}`;
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
/** Notify a friend that someone scheduled a plan with them (best-effort). The APNs sender lands
 *  with the push key; until configured this writes a notification row the sender can pick up. */
async function notifyScheduledWith(
  supabase: SupabaseClient,
  friendId: string,
  byUserId: string,
  title: string,
): Promise<void> {
  const { data: actor } = await supabase.from('profiles')
    .select('display_name,username').eq('id', byUserId).maybeSingle();
  const name = (actor?.display_name as string) || (actor?.username as string) || 'A friend';
  const body = `${name} planned "${title}" with you`;
  await supabase.from('notifications').insert({
    user_id: friendId, kind: 'scheduled_with', actor_id: byUserId, body, delivered: true,
  });
  await sendPush(supabase, friendId, 'Planfect', body);
}

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

interface ResolvedPlace { address?: string; lat?: number; lng?: number; placeId?: string }

function placeFromRow(l: LocationRow): ResolvedPlace {
  if (l.lat != null && l.lng != null) return { lat: l.lat, lng: l.lng };
  if (l.place_id) return { placeId: l.place_id };
  return { address: l.address ?? l.name };
}

function isUuid(s: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
}

/** A Google Place ID is a long, separator-free token (e.g. "ChIJ…"); a real free-text address has
 * spaces/commas (and often non-ASCII). The agent often geocode_place's a spot and then passes the
 * returned placeId straight into estimate_commute as a from/to — so route it to a placeId waypoint,
 * NOT an address waypoint (Routes rejects a Place ID given as an address). */
function looksLikePlaceId(s: string): boolean {
  return /^[A-Za-z0-9_-]{15,}$/.test(s);
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

/** The travel modes the tools expose (matches the estimate_commute / schedule_tasks enums and the
 * Routes mapping above). Returns the normalized mode, or undefined for anything unrecognized so the
 * caller falls back to the user's preferred mode rather than storing garbage. */
const COMMUTE_MODES = ['driving', 'transit', 'walking', 'cycling'];
function normalizeMode(m: unknown): string | undefined {
  const s = String(m ?? '').trim().toLowerCase();
  return COMMUTE_MODES.includes(s) ? s : undefined;
}

function routesWaypoint(p: ResolvedPlace): Record<string, unknown> {
  if (p.lat != null && p.lng != null) return { location: { latLng: { latitude: p.lat, longitude: p.lng } } };
  if (p.placeId) return { placeId: p.placeId };
  return { address: p.address };
}

/** Keep a commute duration sane (1 min … 10 h); a non-finite value falls back to a rough 25 min.
 * Guards against a malformed route duration or a hallucinated commute_min becoming an absurd block. */
function clampCommuteMin(min: number): number {
  if (!Number.isFinite(min)) return 25;
  return Math.min(600, Math.max(1, Math.round(min)));
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
  // Clamp to a sane bound (1 min … 10 h) so a malformed duration never becomes an absurd commute.
  return { durationMin: clampCommuteMin(Math.round(secs / 60)), distanceM: route.distanceMeters ?? 0 };
}
