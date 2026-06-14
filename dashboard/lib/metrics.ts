// Typed queries against the dashboard views (supabase/analytics.sql). Server-side only.

import { serverClient } from './supabaseServer';
import type { ModelRow, UsageDailyRow, DauRow } from './types';

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
