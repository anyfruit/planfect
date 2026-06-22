import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stripThink } from './providers.ts';

// Reasoning models (MiniMax M3, some Qwen) emit chain-of-thought as <think>…</think> inside the
// message content. The OpenAI-compatible adapter strips it so we never show or re-send reasoning.

test('stripThink removes a well-formed <think> block and keeps the answer', () => {
  assert.equal(stripThink('<think>reasoning here</think>\n\nhello from m3'), 'hello from m3');
});

test('stripThink collapses a reasoning-only content (a tool-call turn) to undefined', () => {
  assert.equal(stripThink('<think>deciding to call a tool</think>\n\n'), undefined);
});

test('stripThink drops an unclosed <think> (output truncated by max_tokens)', () => {
  assert.equal(stripThink('<think>got cut off mid thought'), undefined);
});

test('stripThink leaves ordinary content untouched (non-reasoning models)', () => {
  assert.equal(stripThink('Scheduled gym at 7am.'), 'Scheduled gym at 7am.');
});

test('stripThink treats empty / nullish as undefined', () => {
  assert.equal(stripThink(''), undefined);
  assert.equal(stripThink(undefined), undefined);
  assert.equal(stripThink(null), undefined);
});

test('stripThink removes multiple think blocks', () => {
  assert.equal(stripThink('<think>a</think>part1 <think>b</think>part2'), 'part1 part2');
});
