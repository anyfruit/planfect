// Typed queries against the dashboard views (supabase/analytics.sql). Server-side only.

import { serverClient } from './supabaseServer';
import type {
  ModelRow, UsageDailyRow, DauRow,
  UsageDailyTotalRow, UsageBySourceRow, DemoConversationRow,
} from './types';

function sinceISO(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString();
}

export async function getModelComparison(): Promise<ModelRow[]> {
  const { data, error } = await serverClient().from('metrics_model_comparison').select('*');
  if (error) throw error;
  return (data ?? []) as ModelRow[];
}

export async function getUsageDaily(days = 30): Promise<UsageDailyRow[]> {
  const { data, error } = await serverClient()
    .from('metrics_usage_daily')
    .select('*')
    .gte('day', sinceISO(days))
    .order('day', { ascending: true });
  if (error) throw error;
  return (data ?? []) as UsageDailyRow[];
}

export async function getDau(days = 30): Promise<DauRow[]> {
  const { data, error } = await serverClient()
    .from('metrics_dau')
    .select('*')
    .gte('day', sinceISO(days))
    .order('day', { ascending: true });
  if (error) throw error;
  return (data ?? []) as DauRow[];
}

/** Daily totals across all models, per source — the "每天总额 / token" the in-app metrics lacked. */
export async function getUsageDailyTotal(days = 30): Promise<UsageDailyTotalRow[]> {
  const { data, error } = await serverClient()
    .from('metrics_usage_daily_total')
    .select('*')
    .gte('day', sinceISO(days))
    .order('day', { ascending: true });
  if (error) throw error;
  return (data ?? []) as UsageDailyTotalRow[];
}

/** All-time usage split by source (app vs public demo). */
export async function getUsageBySource(): Promise<UsageBySourceRow[]> {
  const { data, error } = await serverClient().from('metrics_usage_by_source').select('*');
  if (error) throw error;
  return (data ?? []) as UsageBySourceRow[];
}

/** Recent public-demo conversations, newest first (for reviewing how guests use the demo). */
export async function getRecentDemoConversations(limit = 50): Promise<DemoConversationRow[]> {
  const { data, error } = await serverClient()
    .from('demo_conversations')
    .select('id,created_at,tz,model,result_type,turns,ip_hash,messages,result')
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data ?? []) as DemoConversationRow[];
}

// --- agent observability (computed in JS from raw rows — volumes are small at this stage) ---

/** One day of plan_turn events: how many turns, what they produced, how long they took. */
export interface AgentTurnDay {
  day: string;
  turns: number;
  errors: number;        // turns that threw (metadata.ok === false)
  scheduled: number;     // receipt produced
  questions: number;     // clarifying-question card
  plain: number;         // plain message reply
  avgSteps: number;      // model steps per turn
  avgMs: number;         // end-to-end turn latency
  p95Ms: number;
  nudges: number;        // integrity-check corrective steps fired (false success/failure claims)
}

interface PlanTurnRow {
  created_at: string;
  metadata: { ok?: boolean; type?: string; steps?: number; nudges?: number; ms?: number };
}

export async function getAgentTurnDays(days = 14): Promise<AgentTurnDay[]> {
  const { data, error } = await serverClient()
    .from('app_events')
    .select('created_at,metadata')
    .eq('type', 'plan_turn')
    .gte('created_at', sinceISO(days))
    .order('created_at', { ascending: false })
    .limit(5000);
  if (error) throw error;
  const byDay = new Map<string, PlanTurnRow[]>();
  for (const r of (data ?? []) as PlanTurnRow[]) {
    const day = r.created_at.slice(0, 10);
    (byDay.get(day) ?? byDay.set(day, []).get(day)!).push(r);
  }
  return [...byDay.entries()].map(([day, rows]) => {
    const ok = rows.filter((r) => r.metadata.ok !== false);
    const ms = ok.map((r) => r.metadata.ms ?? 0).sort((a, b) => a - b);
    return {
      day,
      turns: rows.length,
      errors: rows.length - ok.length,
      scheduled: ok.filter((r) => r.metadata.type === 'scheduled').length,
      questions: ok.filter((r) => r.metadata.type === 'questions').length,
      plain: ok.filter((r) => r.metadata.type === 'message').length,
      avgSteps: avg(ok.map((r) => r.metadata.steps ?? 0)),
      avgMs: avg(ms),
      p95Ms: percentile(ms, 95),
      nudges: ok.reduce((n, r) => n + (r.metadata.nudges ?? 0), 0),
    };
  });
}

/** update_task reliability: every planner edit attempt is logged; surface ok-rate + top errors. */
export interface UpdateTaskHealth {
  total: number;
  ok: number;
  topErrors: { error: string; n: number }[];
}

export async function getUpdateTaskHealth(days = 14): Promise<UpdateTaskHealth> {
  const { data, error } = await serverClient()
    .from('app_events')
    .select('metadata')
    .eq('type', 'planner_update_task')
    .gte('created_at', sinceISO(days))
    .limit(5000);
  if (error) throw error;
  const rows = (data ?? []) as { metadata: { result?: { ok?: boolean; error?: string } } }[];
  const errCounts = new Map<string, number>();
  let ok = 0;
  for (const r of rows) {
    if (r.metadata.result?.ok) { ok++; continue; }
    const e = (r.metadata.result?.error ?? 'unknown').slice(0, 80);
    errCounts.set(e, (errCounts.get(e) ?? 0) + 1);
  }
  const topErrors = [...errCounts.entries()].map(([error, n]) => ({ error, n }))
    .sort((a, b) => b.n - a.n).slice(0, 5);
  return { total: rows.length, ok, topErrors };
}

/** Per-model step latency percentiles + prompt-cache hit rate (both drive UX and cost). */
export interface StepLatencyRow {
  provider: string;
  model: string;
  steps: number;
  p50Ms: number;
  p95Ms: number;
  cacheHitPct: number | null;   // cached input tokens / input tokens; null when no input recorded
}

export async function getStepLatency(days = 14): Promise<StepLatencyRow[]> {
  const { data, error } = await serverClient()
    .from('usage_events')
    .select('provider,model,latency_ms,input_tokens,cached_input_tokens')
    .gte('created_at', sinceISO(days))
    .limit(10000);
  if (error) throw error;
  const rows = (data ?? []) as { provider: string; model: string; latency_ms: number | null; input_tokens: number | null; cached_input_tokens: number | null }[];
  const byModel = new Map<string, typeof rows>();
  for (const r of rows) {
    const k = `${r.provider}:${r.model}`;
    (byModel.get(k) ?? byModel.set(k, []).get(k)!).push(r);
  }
  return [...byModel.entries()].map(([k, list]) => {
    const [provider, ...rest] = k.split(':');
    const lat = list.map((r) => r.latency_ms ?? 0).sort((a, b) => a - b);
    const inTok = list.reduce((n, r) => n + (r.input_tokens ?? 0), 0);
    const cached = list.reduce((n, r) => n + (r.cached_input_tokens ?? 0), 0);
    return {
      provider,
      model: rest.join(':'),
      steps: list.length,
      p50Ms: percentile(lat, 50),
      p95Ms: percentile(lat, 95),
      cacheHitPct: inTok > 0 ? (cached / inTok) * 100 : null,
    };
  }).sort((a, b) => b.steps - a.steps);
}

function avg(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}

/** Nearest-rank percentile of an ASCENDING-sorted array. */
function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
}

// --- runtime config: the planner model switcher (writes are gated by the dashboard's Basic-Auth) ---

export type RuntimeConfig = Record<string, string>;

/** All runtime_config key/values (e.g. planner_provider_app, planner_model_demo, …). */
export async function getRuntimeConfig(): Promise<RuntimeConfig> {
  const { data, error } = await serverClient().from('runtime_config').select('key,value');
  if (error) throw error;
  const out: RuntimeConfig = {};
  for (const r of (data ?? []) as { key: string; value: string }[]) out[r.key] = r.value;
  return out;
}

/** Upsert one or more runtime_config entries (service-role; called from a server action). */
export async function setRuntimeConfig(entries: RuntimeConfig): Promise<void> {
  const rows = Object.entries(entries).map(([key, value]) => ({ key, value, updated_at: new Date().toISOString() }));
  const { error } = await serverClient().from('runtime_config').upsert(rows);
  if (error) throw error;
}
