// Row shapes for the analytics views (supabase/analytics.sql). ModelRow lives in format.ts
// (kept dependency-free for testing) and is re-exported here for convenience.

export type { ModelRow } from './format';

export interface UsageDailyRow {
  day: string;
  provider: string;
  model: string;
  calls: number;
  input_tokens: number;
  output_tokens: number;
  cached_input_tokens: number;
  cost_usd: number;
  avg_latency_ms: number | null;
  errors: number;
}

export interface DauRow {
  day: string;
  active_users: number;
  actions: number;
}
