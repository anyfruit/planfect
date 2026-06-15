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
  TOOL_WEB_SEARCH,
  TOOL_SET_ROUTINE,
} from '../../../server/llm/tools.ts';

export interface PlanContext {
  routines: unknown[];
  locations: LocationRow[];
  timezone: string;
  blocks: unknown[];   // upcoming time_blocks, so the planner knows the user's current plans
  homeLocationId?: string;
  workLocationId?: string;
  preferredModes: string[];   // ordered: e.g. ['transit','walking','driving']
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
  const [routines, locations, profile] = await Promise.all([
    supabase.from('routines').select('*').eq('user_id', userId),
    supabase.from('locations').select('id,name,address,lat,lng,place_id').eq('user_id', userId),
    supabase.from('profiles').select('timezone,home_location_id,work_location_id,preferred_modes').eq('id', userId).single(),
  ]);
  const timezone = profile.data?.timezone ?? 'UTC';
  // Upcoming schedule from the start of today (user's tz) so the planner knows existing plans and
  // never claims the day is empty when it isn't.
  const ymd = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date()).split('-').map(Number);
  const fromUtc = new Date(zonedToUtc({ year: ymd[0], month: ymd[1], day: ymd[2] }, 0, timezone)).toISOString();
  const { data: blocks } = await supabase
    .from('time_blocks')
    .select('title,kind,status,start_at,end_at')
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
  };
}

export function buildSystemPrompt(ctx: PlanContext): string {
  // Stable prefix first (routine/locations) for prompt-cache friendliness; the volatile
  // "today" line goes LAST so it doesn't bust the cacheable prefix.
  const now = new Date();
  const ymd = new Intl.DateTimeFormat('en-CA', {
    timeZone: ctx.timezone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now);
  const weekday = new Intl.DateTimeFormat('en-US', { timeZone: ctx.timezone, weekday: 'long' }).format(now);
  return [
    'You are Planfect — a warm, upbeat day-planning companion who talks like a thoughtful friend, not',
    'a form. Be concise and human: a little personality and the occasional light emoji are welcome,',
    'never chatty for its own sake. Celebrate small wins ("nice — locked in 🎉"), and when something',
    'is during work or tight, be gently real about it. Users talk casually and briefly — often just',
    '"gym", "call the dentist", "groceries". Never interrogate them or demand specifics; make smart',
    'assumptions and keep it to one quick confirmation.',
    'Always write your questions, options, and receipts in the SAME language the user wrote in.',
    `Timezone: ${ctx.timezone}.`,
    `The user's routine — schedule AROUND these by default, but they are SOFT, not hard walls: ${JSON.stringify(ctx.routines)}`,
    `Already on the user's calendar (their CURRENT plans — never say a day is empty if any fall on it): ${formatBlocks(ctx.blocks, ctx.timezone)}`,
    `Saved locations: ${JSON.stringify(ctx.locations)}`,
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
    'Routine blocks (work, meals, commute) are defaults to plan AROUND — NOT bans. You MAY schedule',
    'over them (pass allow_over_routine=true) when the user asks for a time during them, says they',
    "will take time off / step out / 摸鱼, or the task can only happen then — e.g. a dentist or car",
    'inspection during business hours for a 9-5 worker. Then just schedule it and note it lands during',
    'work. Only SLEEP is truly off-limits. NEVER refuse or block a time the user clearly wants.',
    'If the user says their ROUTINE itself changed (work hours, sleep, meal times, commute, a',
    'recurring commitment), call set_routine to add/update/delete it — reference existing routines by',
    'their id — then confirm briefly. Do not create a one-off task for a routine change. If the change',
    'applies to only SOME of a routine\'s days (e.g. "Fridays I finish at 3"), SPLIT it: update the',
    'original to drop those days, then ADD a new routine for them — do not change all days at once.',
    'If the user names an external event whose real time you do not know — a match / tournament,',
    'movie showtime, concert, show, livestream, TV broadcast, store hours — call web_search to find',
    'the actual time(s), then schedule the watching/attending AT those exact times: pass start_local',
    'set to the event start time, and allow_over_routine=true whenever that time overlaps a routine',
    '(work / meal / commute) — the user has chosen to watch it then, so a fixed event time wins over',
    'work. Never say you cannot look things up. If the search is inconclusive, say what you found and',
    'ask the user for the time.',
    'Be efficient: infer free days from the routine directly (a weekday job means weekends are open) —',
    'call get_schedule at most once, for the day you intend to propose. Do not keep exploring; decide',
    'and ask within a couple of tool calls.',
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
    `Today is ${weekday}, ${ymd} (${ctx.timezone}); resolve relative dates like "this Friday" / "tomorrow" against it.`,
  ].join('\n');
}

export function buildHandlers(
  supabase: SupabaseClient,
  userId: string,
  ctx: PlanContext,
  analytics?: SupabaseClient,
  searchApiKey?: string,
  mapsApiKey?: string,
): ToolHandlers {
  const routines = toRoutineInputs(ctx.routines);
  const tz = ctx.timezone;

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
      const query = String(args.query ?? '').trim();
      if (!query || !searchApiKey) return JSON.stringify({ result: 'Web search is unavailable.' });
      try {
        const res = await fetch('https://api.openai.com/v1/responses', {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${searchApiKey}` },
          body: JSON.stringify({
            model: 'gpt-4.1',
            tools: [{ type: 'web_search' }],
            input: `${query}\n\nUse authoritative, current sources (the event's official schedule page, well-known listings). Give the concrete date and exact start time(s) in the event's local timezone AND name the source. If sources disagree or you can't verify the time, say so plainly — do not guess.`,
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
        .select('start_at,end_at,kind,title,status')
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

    [TOOL_ESTIMATE_COMMUTE]: async (args) => {
      const fromArg = String(args.from_location_id ?? '').trim();
      const toArg = String(args.to_location_id ?? '').trim();
      const arriveBy = args.arrive_by ? String(args.arrive_by) : undefined;
      const mode = ctx.preferredModes[0] ?? 'transit';
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
        // Routine is a soft default. Schedule over it (work/meals — not sleep, which already bounds
        // availability) when the user opts in OR pinned an explicit time via start_local; then we
        // avoid only other booked tasks. An explicit time is authoritative — never shift it.
        const overRoutine = t.allow_over_routine === true || !!t.start_local;
        const blocking = overRoutine ? dayBusy : [...busy, ...dayBusy];

        const placement = scheduleTask(availability, blocking, {
          durationMin,
          commuteMin: t.commute_min,
          bufferMin: t.buffer_min,
          sessionMin: t.session_min,
          earliestStart: t.start_local
            ? zonedToUtc(date, timeToMin(t.start_local), tz)
            : (t.earliest_start ? Date.parse(t.earliest_start) : undefined),
          deadline: t.deadline ? Date.parse(t.deadline) : undefined,
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

/** Compact, timezone-local summary of existing blocks for the system prompt. */
function formatBlocks(blocks: unknown[], tz: string): string {
  const list = (blocks as Array<Record<string, unknown>>) ?? [];
  if (!list.length) return 'nothing yet';
  const span = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  });
  const endf = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' });
  return list
    .map((b) => `${span.format(new Date(String(b.start_at)))}–${endf.format(new Date(String(b.end_at)))} ${String(b.title)}${b.status === 'done' ? ' (done)' : ''}`)
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
