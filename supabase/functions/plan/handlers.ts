// DB- and maps-backed tool handlers + usage sink for the /plan Edge Function (Deno).
//
// SCAFFOLD: the handlers that READ are wired; the ones that WRITE the schedule have TODOs to
// finish against the live schema (deriving availability from routines + range, inserting
// time_blocks). The pure placement logic they delegate to — scheduleTask — is unit-tested
// (server/scheduling), and server/demo/planDemo.ts shows it producing real times end-to-end.

import { type SupabaseClient } from 'jsr:@supabase/supabase-js@2';
import { type ToolHandlers } from '../../../server/planner.ts';
import { type UsageEvent, type UsageSink } from '../../../server/usage.ts';
// import { scheduleTask } from '../../../server/scheduling/scheduler.ts'; // used once schedule writes are implemented
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
  // Keep the stable prefix first (routine/locations) so it stays prompt-cache-friendly.
  return [
    'You are Planfect, a calm, precise day-planning assistant.',
    `Timezone: ${ctx.timezone}.`,
    `Routine (never schedule over inviolable blocks): ${JSON.stringify(ctx.routines)}`,
    `Saved locations: ${JSON.stringify(ctx.locations)}`,
    'Estimate missing durations; for a task at a location, estimate_commute and add a commute + buffer.',
    'Ask (ask_user_questions) before guessing on consequential ambiguities. When done, call',
    'schedule_tasks, then reply with a short receipt of exactly what you scheduled.',
  ].join('\n');
}

export function buildHandlers(supabase: SupabaseClient, userId: string): ToolHandlers {
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
      // TODO (Phase 2): for each task, derive availability from `routines` for the target
      // range, load busy from `time_blocks`, call scheduleTask(...), then insert tasks +
      // time_blocks (incl. commute/buffer). See server/demo/planDemo.ts for the real call.
      const items = ((args.tasks as Array<{ title: string }>) ?? []).map((t) => ({
        title: t.title,
        start: null,
        end: null,
      }));
      return JSON.stringify({ items, assumptions: ['(scaffold) schedule writes not yet wired'] });
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
