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
} from '../../../server/llm/tools.ts';

export interface PlanContext {
  routines: unknown[];
  locations: unknown[];
  timezone: string;
}

export async function loadContext(supabase: SupabaseClient, userId: string): Promise<PlanContext> {
  const [routines, locations, profile] = await Promise.all([
    supabase.from('routines').select('*').eq('user_id', userId),
    supabase.from('locations').select('*').eq('user_id', userId),
    supabase.from('profiles').select('timezone').eq('id', userId).single(),
  ]);
  return {
    routines: routines.data ?? [],
    locations: locations.data ?? [],
    timezone: profile.data?.timezone ?? 'UTC',
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
    'You are Planfect, a calm, precise day-planning assistant.',
    `Timezone: ${ctx.timezone}.`,
    `Routine (never schedule over inviolable blocks): ${JSON.stringify(ctx.routines)}`,
    `Saved locations: ${JSON.stringify(ctx.locations)}`,
    'Estimate missing durations; for a task at a location, estimate_commute and add a commute + buffer.',
    'Ask (ask_user_questions) before guessing on consequential ambiguities. When done, call',
    "schedule_tasks with each task's date (YYYY-MM-DD) plus any commute_min / earliest_start, then",
    'reply with a short receipt of exactly what you scheduled.',
    `Today is ${weekday}, ${ymd} (${ctx.timezone}); resolve relative dates like "this Friday" or "tomorrow" against it.`,
  ].join('\n');
}

export function buildHandlers(
  supabase: SupabaseClient,
  userId: string,
  ctx: PlanContext,
  analytics?: SupabaseClient,
): ToolHandlers {
  const routines = toRoutineInputs(ctx.routines);
  const tz = ctx.timezone;
  return {
    [TOOL_GET_SCHEDULE]: async (args) => {
      const { data } = await supabase
        .from('time_blocks')
        .select('start_at,end_at,kind,title')
        .eq('user_id', userId)
        .gte('start_at', String(args.start))
        .lte('start_at', String(args.end))
        .order('start_at');
      return JSON.stringify(data ?? []);
    },

    [TOOL_ESTIMATE_COMMUTE]: async () => {
      // TODO: resolve from/to lat-lng from `locations`, call the configured MapsProvider.
      return JSON.stringify({ mode: 'transit', durationMin: 25, distanceM: 6000 });
    },

    [TOOL_GEOCODE_PLACE]: async (args) => {
      // TODO: MapsProvider.geocode(query) then upsert into `locations`; returning a stub.
      return JSON.stringify({ name: String(args.query), placeId: null });
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

        const placement = scheduleTask(availability, [...busy, ...dayBusy], {
          durationMin,
          commuteMin: t.commute_min,
          bufferMin: t.buffer_min,
          sessionMin: t.session_min,
          earliestStart: t.earliest_start ? Date.parse(t.earliest_start) : undefined,
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
            })),
          );
        } else {
          rows.push(blockRow(userId, t.title, 'task', sessions[0], {
            task_id: taskId,
            location_id: t.location_id ?? null,
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
  location_id?: string | null;
  commute_min?: number;
  buffer_min?: number;
  session_min?: number;
  earliest_start?: string; // ISO-8601
  deadline?: string;       // ISO-8601
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
