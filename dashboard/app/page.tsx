import {
  getModelComparison, getDau, getUsageDailyTotal, getUsageBySource, getRecentDemoConversations,
} from '../lib/metrics';
import { sortByCost, totals, dailyGrandTotals, formatUsd, formatTokens, formatNumber, pct } from '../lib/format';
import type { DemoConversationRow } from '../lib/types';

// Always render fresh (admin dashboard; no static caching of metrics).
export const dynamic = 'force-dynamic';

export default async function DashboardPage() {
  const [models, dau, dailyRows, bySource, demos] = await Promise.all([
    getModelComparison(),
    getDau(30),
    getUsageDailyTotal(30),
    getUsageBySource(),
    getRecentDemoConversations(50),
  ]);

  const t = totals(models);
  const peakActive = dau.reduce((m, d) => Math.max(m, d.active_users), 0);
  const daily = dailyGrandTotals(dailyRows).slice().reverse();   // newest day first
  const maxDailyCost = Math.max(1e-9, ...daily.map((d) => d.cost));
  const maxModelCost = Math.max(1e-9, ...models.map((m) => m.cost_usd ?? 0));
  const appRow = bySource.find((r) => r.source === 'app');
  const demoRow = bySource.find((r) => r.source === 'demo');

  return (
    <main style={{ fontFamily: 'system-ui, sans-serif', maxWidth: 1040, margin: '0 auto', padding: 24 }}>
      <h1 style={{ marginBottom: 4 }}>Planfect — Developer Dashboard</h1>
      <p style={{ color: '#888', marginTop: 0 }}>Usage, cost, and model comparison. Daily totals over the last 30 days.</p>

      <section style={{ display: 'flex', gap: 16, flexWrap: 'wrap', margin: '16px 0 8px' }}>
        <Kpi label="Model calls" value={formatNumber(t.calls)} />
        <Kpi label="Tokens" value={formatTokens(t.tokens)} />
        <Kpi label="Spend (total)" value={formatUsd(t.costUsd)} />
        <Kpi label="App spend" value={formatUsd(appRow?.cost_usd ?? 0)} />
        <Kpi label="Demo spend" value={formatUsd(demoRow?.cost_usd ?? 0)} accent />
        <Kpi label="Active users (peak/day)" value={formatNumber(peakActive)} />
      </section>

      <h2>App vs demo</h2>
      <p style={hint}>Where the spend goes: the signed-in app vs the public web demo (anonymous, no DB writes).</p>
      <Table head={['Source', 'Calls', 'Tokens', 'Cost']}>
        {bySource.length === 0 && <tr><Td colSpan={4}>No usage yet.</Td></tr>}
        {bySource.map((r) => (
          <tr key={r.source}>
            <Td>{r.source === 'demo' ? '🌐 Demo (public)' : '📱 App (signed-in)'}</Td>
            <Td>{formatNumber(r.calls)}</Td>
            <Td>{formatTokens(r.total_tokens)}</Td>
            <Td>{formatUsd(r.cost_usd)}</Td>
          </tr>
        ))}
      </Table>

      <h2>Daily totals</h2>
      <Table head={['Day', 'Calls', 'Tokens', 'Cost', 'Cost (relative)']}>
        {daily.length === 0 && <tr><Td colSpan={5}>No usage yet.</Td></tr>}
        {daily.map((d) => (
          <tr key={d.day}>
            <Td>{d.day}</Td>
            <Td>{formatNumber(d.calls)}</Td>
            <Td>{formatTokens(d.tokens)}</Td>
            <Td>{formatUsd(d.cost)}</Td>
            <Td><Bar frac={d.cost / maxDailyCost} /></Td>
          </tr>
        ))}
      </Table>

      <h2>Model comparison</h2>
      <Table head={['Provider', 'Model', 'Calls', 'Tokens', 'Cost', 'Avg latency', 'Error %', 'Cost (relative)']}>
        {models.length === 0 && <tr><Td colSpan={8}>No usage yet — data appears once the planner runs.</Td></tr>}
        {sortByCost(models).map((m) => (
          <tr key={m.provider + m.model}>
            <Td>{m.provider}</Td>
            <Td>{m.model}</Td>
            <Td>{formatNumber(m.calls)}</Td>
            <Td>{formatTokens(m.total_tokens)}</Td>
            <Td>{formatUsd(m.cost_usd)}</Td>
            <Td>{m.avg_latency_ms ? Math.round(m.avg_latency_ms) + ' ms' : '—'}</Td>
            <Td>{pct(m.error_rate_pct)}</Td>
            <Td><Bar frac={(m.cost_usd ?? 0) / maxModelCost} /></Td>
          </tr>
        ))}
      </Table>

      <h2>Recent demo conversations</h2>
      <p style={hint}>What guests typed into the public demo, newest first. Anonymous — the IP is stored hashed, never raw.</p>
      <Table head={['When', 'Type', 'Turns', 'First message', 'Result']}>
        {demos.length === 0 && <tr><Td colSpan={5}>No demo conversations yet.</Td></tr>}
        {demos.map((c) => (
          <tr key={c.id}>
            <Td>{fmtWhen(c.created_at)}</Td>
            <Td><span style={pill(c.result_type)}>{c.result_type ?? '—'}</span></Td>
            <Td>{c.turns}</Td>
            <Td><span style={{ color: '#222' }}>{firstUserMsg(c.messages)}</span></Td>
            <Td><span style={{ color: '#666' }}>{resultSummary(c.result)}</span></Td>
          </tr>
        ))}
      </Table>

      <p style={{ color: '#aaa', marginTop: 24, fontSize: 13 }}>
        Next: time-series charts and admin-auth instead of the service-role key. See dashboard/README.md.
      </p>
    </main>
  );
}

// ---- demo-conversation presentation helpers ----

function firstUserMsg(messages: { role: string; content: string }[]): string {
  const m = (messages ?? []).find((x) => x.role === 'user');
  return truncate(m?.content ?? '(empty)', 90);
}

function resultSummary(result: unknown): string {
  const r = result as { type?: string; receipt?: { items?: { title?: string }[] }; questions?: { question?: string }[]; text?: string };
  if (!r || typeof r !== 'object') return '—';
  if (r.type === 'scheduled') {
    const titles = (r.receipt?.items ?? []).map((i) => i.title).filter(Boolean);
    return titles.length ? '📅 ' + truncate(titles.join('、'), 80) : '📅 scheduled';
  }
  if (r.type === 'questions') return '❓ ' + truncate((r.questions ?? []).map((q) => q.question).filter(Boolean).join(' ') || 'asked', 80);
  if (typeof r.text === 'string') return '💬 ' + truncate(r.text, 80);
  return r.type ?? '—';
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

function fmtWhen(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

// ---- UI atoms ----

const hint: React.CSSProperties = { color: '#999', fontSize: 13, margin: '2px 0 8px' };

function pill(type: string | null): React.CSSProperties {
  const c = type === 'scheduled' ? '#34a853' : type === 'questions' ? '#f59e0b' : type === 'error' ? '#ef4444' : '#6e54f0';
  return { background: c + '22', color: c, padding: '2px 8px', borderRadius: 999, fontSize: 12, fontWeight: 700, whiteSpace: 'nowrap' };
}

function Bar({ frac }: { frac: number }) {
  const w = Math.max(0, Math.min(1, frac)) * 100;
  return (
    <div style={{ background: '#f0f0f3', borderRadius: 4, height: 8, width: 130 }}>
      <div style={{ width: w + '%', background: '#6e54f0', height: 8, borderRadius: 4 }} />
    </div>
  );
}

function Kpi({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div style={{ border: '1px solid ' + (accent ? '#d9d2fb' : '#eee'), background: accent ? '#f7f5ff' : '#fff', borderRadius: 12, padding: 16, minWidth: 150 }}>
      <div style={{ color: '#888', fontSize: 13 }}>{label}</div>
      <div style={{ fontSize: 26, fontWeight: 700 }}>{value}</div>
    </div>
  );
}

function Table({ head, children }: { head: string[]; children: React.ReactNode }) {
  return (
    <table style={{ borderCollapse: 'collapse', width: '100%', margin: '8px 0 24px', background: '#fff' }}>
      <thead>
        <tr>{head.map((h) => <th key={h} style={{ textAlign: 'left', borderBottom: '2px solid #eee', padding: '6px 10px', fontSize: 13 }}>{h}</th>)}</tr>
      </thead>
      <tbody>{children}</tbody>
    </table>
  );
}

function Td({ children, colSpan }: { children: React.ReactNode; colSpan?: number }) {
  return <td colSpan={colSpan} style={{ borderBottom: '1px solid #f2f2f2', padding: '6px 10px', fontSize: 14 }}>{children}</td>;
}
