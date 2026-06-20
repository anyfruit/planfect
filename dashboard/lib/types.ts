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

export interface UsageDailyTotalRow {
  day: string;
  source: string;        // 'app' | 'demo'
  calls: number;
  total_tokens: number;
  cost_usd: number;
}

export interface UsageBySourceRow {
  source: string;        // 'app' | 'demo'
  calls: number;
  total_tokens: number;
  cost_usd: number;
}

export interface DemoConversationRow {
  id: string;
  created_at: string;
  tz: string | null;
  model: string | null;
  result_type: string | null;
  turns: number;
  ip_hash: string | null;
  messages: { role: string; content: string }[];
  result: unknown;       // the planner result (receipt / questions / message)
}
