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
