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
