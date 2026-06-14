import { getModelComparison, getUsageDaily, getDau } from '../lib/metrics';
import { sortByCost, totals, formatUsd, formatTokens, formatNumber, pct } from '../lib/format';

// Always render fresh (admin dashboard; no static caching of metrics).
export const dynamic = 'force-dynamic';

export default async function DashboardPage() {
  const [models, usageDaily, dau] = await Promise.all([
    getModelComparison(),
    getUsageDaily(30),
    getDau(30),
  ]);

  const t = totals(models);
  const peakActive = dau.reduce((m, d) => Math.max(m, d.active_users), 0);
  const actions30d = dau.reduce((s, d) => s + d.actions, 0);

  return (
    <main style={{ fontFamily: 'system-ui, sans-serif', maxWidth: 1040, margin: '0 auto', padding: 24 }}>
      <h1 style={{ marginBottom: 4 }}>Planfect — Developer Dashboard</h1>
      <p style={{ color: '#888', marginTop: 0 }}>Usage, cost, and model comparison (last 30 days).</p>

      <section style={{ display: 'flex', gap: 16, flexWrap: 'wrap', margin: '16px 0 8px' }}>
        <Kpi label="Model calls" value={formatNumber(t.calls)} />
        <Kpi label="Tokens" value={formatTokens(t.tokens)} />
        <Kpi label="Spend" value={formatUsd(t.costUsd)} />
        <Kpi label="Active users (peak/day)" value={formatNumber(peakActive)} />
        <Kpi label="Actions (30d)" value={formatNumber(actions30d)} />
      </section>

      <h2>Model comparison</h2>
      <Table head={['Provider', 'Model', 'Calls', 'Tokens', 'Cost', 'Avg latency', 'Error %']}>
        {sortByCost(models).map((m) => (
          <tr key={m.provider + m.model}>
            <Td>{m.provider}</Td>
            <Td>{m.model}</Td>
            <Td>{formatNumber(m.calls)}</Td>
            <Td>{formatTokens(m.total_tokens)}</Td>
            <Td>{formatUsd(m.cost_usd)}</Td>
            <Td>{m.avg_latency_ms ? Math.round(m.avg_latency_ms) + ' ms' : '—'}</Td>
            <Td>{pct(m.error_rate_pct)}</Td>
          </tr>
        ))}
        {models.length === 0 && (
          <tr><Td colSpan={7}>No usage yet — data appears once the planner runs.</Td></tr>
        )}
      </Table>

      <h2>Daily usage</h2>
      <Table head={['Day', 'Provider', 'Model', 'Calls', 'Cost']}>
        {usageDaily.map((r, i) => (
          <tr key={i}>
            <Td>{String(r.day).slice(0, 10)}</Td>
            <Td>{r.provider}</Td>
            <Td>{r.model}</Td>
            <Td>{formatNumber(r.calls)}</Td>
            <Td>{formatUsd(r.cost_usd)}</Td>
          </tr>
        ))}
        {usageDaily.length === 0 && <tr><Td colSpan={5}>No usage yet.</Td></tr>}
      </Table>

      <p style={{ color: '#aaa', marginTop: 24, fontSize: 13 }}>
        Next: time-series charts (recharts/visx) and admin-auth instead of the service-role key.
        See dashboard/README.md.
      </p>
    </main>
  );
}

function Kpi({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ border: '1px solid #eee', background: '#fff', borderRadius: 12, padding: 16, minWidth: 150 }}>
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
