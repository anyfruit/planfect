// Pure presentation helpers for the dashboard. Intentionally dependency-free so they can be
// unit-tested on Node (see format.test.ts) without pulling in Next/React/Supabase.

export interface ModelRow {
  provider: string;
  model: string;
  calls: number;
  total_tokens: number;
  cost_usd: number;
  avg_latency_ms: number | null;
  error_rate_pct: number | null;
}

export function formatUsd(n: number): string {
  return '$' + (n < 1 ? n.toFixed(4) : n.toFixed(2));
}

export function formatTokens(n: number): string {
  if (n >= 1e9) return (n / 1e9).toFixed(1) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return String(n);
}

export function formatNumber(n: number): string {
  return n.toLocaleString('en-US');
}

export function pct(n: number | null): string {
  return (n ?? 0).toFixed(1) + '%';
}

/** Model leaderboard, most expensive first (the comparison panel's default order). */
export function sortByCost(rows: ModelRow[]): ModelRow[] {
  return [...rows].sort((a, b) => (b.cost_usd ?? 0) - (a.cost_usd ?? 0));
}

/** Collapse per-day-per-source rows into one grand total per day (app + demo combined), oldest first. */
export function dailyGrandTotals(
  rows: { day: string; calls: number; total_tokens: number; cost_usd: number }[],
): { day: string; calls: number; tokens: number; cost: number }[] {
  const byDay = new Map<string, { day: string; calls: number; tokens: number; cost: number }>();
  for (const r of rows) {
    const day = String(r.day).slice(0, 10);
    const cur = byDay.get(day) ?? { day, calls: 0, tokens: 0, cost: 0 };
    cur.calls += r.calls ?? 0;
    cur.tokens += r.total_tokens ?? 0;
    cur.cost += r.cost_usd ?? 0;
    byDay.set(day, cur);
  }
  return [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day));
}

export function totals(rows: ModelRow[]): { calls: number; tokens: number; costUsd: number } {
  return rows.reduce(
    (acc, r) => ({
      calls: acc.calls + (r.calls ?? 0),
      tokens: acc.tokens + (r.total_tokens ?? 0),
      costUsd: acc.costUsd + (r.cost_usd ?? 0),
    }),
    { calls: 0, tokens: 0, costUsd: 0 },
  );
}
