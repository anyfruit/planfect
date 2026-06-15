import { test } from 'node:test';
import assert from 'node:assert/strict';
import { estimateCostUsd } from './usage.ts';

const close = (a: number, b: number) => Math.abs(a - b) < 1e-6;

test('gpt-4.1: 1M in + 1M out = $2 + $8 = $10', () => {
  const c = estimateCostUsd('openai', 'gpt-4.1', { inputTokens: 1_000_000, outputTokens: 1_000_000 });
  assert.ok(close(c, 10), `got ${c}`);
});

test('anthropic opus 4.8: 1M in + 1M out = $5 + $25 = $30', () => {
  const c = estimateCostUsd('anthropic', 'claude-opus-4-8', { inputTokens: 1_000_000, outputTokens: 1_000_000 });
  assert.ok(close(c, 30), `got ${c}`);
});

test('cached input is cheaper than fresh input (gpt-5.5)', () => {
  const fresh = estimateCostUsd('openai', 'gpt-5.5', { inputTokens: 1_000_000, outputTokens: 0 });
  const cached = estimateCostUsd('openai', 'gpt-5.5', { inputTokens: 1_000_000, outputTokens: 0, cachedInputTokens: 1_000_000 });
  assert.ok(cached < fresh);
  assert.ok(close(cached, 0.5), `got ${cached}`);
});

test('unknown model returns 0 (never invents a cost)', () => {
  assert.equal(estimateCostUsd('qwen', 'mystery-model', { inputTokens: 1000, outputTokens: 1000 }), 0);
});

test('dated snapshot id falls back to the base model price (gpt-4.1-2025-04-14)', () => {
  const dated = estimateCostUsd('openai', 'gpt-4.1-2025-04-14', { inputTokens: 1_000_000, outputTokens: 1_000_000 });
  assert.ok(close(dated, 10), `got ${dated}`);
});
