import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatUsd, formatTokens, formatNumber, sortByCost, totals, type ModelRow } from './format.ts';

test('formatUsd uses 4 dp under $1, 2 dp otherwise', () => {
  assert.equal(formatUsd(0.03), '$0.0300');
  assert.equal(formatUsd(12.5), '$12.50');
});

test('formatTokens abbreviates', () => {
  assert.equal(formatTokens(6000), '6.0K');
  assert.equal(formatTokens(2_500_000), '2.5M');
  assert.equal(formatTokens(950), '950');
});

test('formatNumber groups thousands', () => {
  assert.equal(formatNumber(1234567), '1,234,567');
});

const rows: ModelRow[] = [
  { provider: 'openai', model: 'gpt-4.1', calls: 10, total_tokens: 1000, cost_usd: 0.2, avg_latency_ms: 800, error_rate_pct: 0 },
  { provider: 'anthropic', model: 'claude-opus-4-8', calls: 5, total_tokens: 2000, cost_usd: 1.5, avg_latency_ms: 1200, error_rate_pct: 1.5 },
];

test('sortByCost orders most expensive first', () => {
  const s = sortByCost(rows);
  assert.equal(s[0].model, 'claude-opus-4-8');
  assert.equal(s[1].model, 'gpt-4.1');
});

test('totals sums calls/tokens/cost', () => {
  const t = totals(rows);
  assert.equal(t.calls, 15);
  assert.equal(t.tokens, 3000);
  assert.ok(Math.abs(t.costUsd - 1.7) < 1e-9);
});
