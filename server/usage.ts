// Usage accounting — the data foundation for the developer dashboard (per-call provider,
// model, tokens, cost, latency). The planner emits a UsageEvent per model step; the Edge
// Function persists it to the `usage_events` table (supabase/analytics.sql).

import { type LLMProvider, type LLMUsage } from './llm/types.ts';

export interface UsageEvent {
  userId: string;
  conversationId?: string;
  provider: LLMProvider;
  model: string;
  action: string;        // e.g. 'plan_step'
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  costUsd: number;
  latencyMs: number;
  success: boolean;
  createdAt: string;     // ISO-8601
}

export interface UsageSink {
  record(e: UsageEvent): void | Promise<void>;
}

/** In-memory sink for tests/dev; production uses a Supabase-backed sink. */
export class MemoryUsageSink implements UsageSink {
  events: UsageEvent[] = [];
  record(e: UsageEvent): void {
    this.events.push(e);
  }
  totalTokens(): number {
    return this.events.reduce((s, e) => s + e.inputTokens + e.outputTokens, 0);
  }
  totalCostUsd(): number {
    return this.events.reduce((s, e) => s + e.costUsd, 0);
  }
}

export interface ModelPrice {
  inputPerM: number;       // USD per 1M input tokens
  outputPerM: number;      // USD per 1M output tokens
  cachedInputPerM?: number;
}

// `${provider}:${model}` → price. Figures dated 2026-06; verify before relying on cost.
export const PRICING: Record<string, ModelPrice> = {
  'openai:gpt-5.5': { inputPerM: 5, outputPerM: 30, cachedInputPerM: 0.5 },
  'openai:gpt-5.4': { inputPerM: 2.5, outputPerM: 15 },
  'openai:gpt-5.3': { inputPerM: 1.75, outputPerM: 12, cachedInputPerM: 0.175 }, // ESTIMATE — verify
  'openai:gpt-5.3-chat-latest': { inputPerM: 1.75, outputPerM: 12, cachedInputPerM: 0.175 }, // ESTIMATE — verify
  'openai:gpt-5.2-chat-latest': { inputPerM: 1.5, outputPerM: 11, cachedInputPerM: 0.15 }, // ESTIMATE — verify
  'openai:gpt-5.1': { inputPerM: 1.25, outputPerM: 10, cachedInputPerM: 0.125 }, // ESTIMATE — verify against OpenAI pricing
  'openai:gpt-5.1-chat-latest': { inputPerM: 1.25, outputPerM: 10, cachedInputPerM: 0.125 }, // ESTIMATE — verify
  'openai:gpt-4.1': { inputPerM: 2, outputPerM: 8 },
  'openai:gpt-4.1-mini': { inputPerM: 0.4, outputPerM: 1.6 },
  'openai:gpt-4.1-nano': { inputPerM: 0.1, outputPerM: 0.4 },
  'anthropic:claude-opus-4-8': { inputPerM: 5, outputPerM: 25 },
  'anthropic:claude-sonnet-4-6': { inputPerM: 3, outputPerM: 15 },
  'anthropic:claude-haiku-4-5': { inputPerM: 1, outputPerM: 5 },
  // Qwen (Alibaba DashScope) — TODO: verify current pricing before trusting cost figures.
  'qwen:qwen-max': { inputPerM: 0, outputPerM: 0 },
  'qwen:qwen-plus': { inputPerM: 0, outputPerM: 0 },
  'qwen:qwen-turbo': { inputPerM: 0, outputPerM: 0 },
  // MiniMax (api.minimaxi.com) — CNY list converted to USD at ¥7.2/$ (2026-06). M3 is the ≤512k
  // input '永久五折' rate (list is 2×; the >512k tier is higher). Verify before trusting figures.
  'minimax:MiniMax-M3': { inputPerM: 0.29, outputPerM: 1.17, cachedInputPerM: 0.058 },
  'minimax:MiniMax-M2.7': { inputPerM: 0.29, outputPerM: 1.17, cachedInputPerM: 0.058 },
  'minimax:MiniMax-M2.7-highspeed': { inputPerM: 0.58, outputPerM: 2.33, cachedInputPerM: 0.058 },
  // Kimi / Moonshot (api.moonshot.cn) — platform.kimi.com list (2026-07), CNY at ¥7.2/$.
  // k2.6: ¥6.5 in / ¥1.1 cached / ¥27 out; k3 (flagship): ¥20 in / ¥2 cached / ¥100 out.
  'kimi:kimi-k2.6': { inputPerM: 0.90, outputPerM: 3.75, cachedInputPerM: 0.15 },
  'kimi:kimi-k3': { inputPerM: 2.78, outputPerM: 13.89, cachedInputPerM: 0.28 },
};

/** Strip a dated snapshot suffix so a vendor-returned id matches PRICING:
 *  'gpt-4.1-2025-04-14' → 'gpt-4.1', 'claude-sonnet-4-6-20250930' → 'claude-sonnet-4-6'. */
function baseModelId(model: string): string {
  return model.replace(/-(\d{4}-\d{2}-\d{2}|\d{8})$/, '');
}

/** Estimate USD cost of one call. Returns 0 for unknown models (never invents a cost). */
export function estimateCostUsd(provider: LLMProvider, model: string, usage: LLMUsage): number {
  const p = PRICING[`${provider}:${model}`] ?? PRICING[`${provider}:${baseModelId(model)}`];
  if (!p) return 0;
  const cached = usage.cachedInputTokens ?? 0;
  const freshInput = Math.max(0, usage.inputTokens - cached);
  return (
    (freshInput * p.inputPerM) / 1e6 +
    (cached * (p.cachedInputPerM ?? p.inputPerM)) / 1e6 +
    (usage.outputTokens * p.outputPerM) / 1e6
  );
}

export interface UsageContext {
  userId: string;
  conversationId?: string;
}

export function makeUsageEvent(
  provider: LLMProvider,
  model: string,
  action: string,
  usage: LLMUsage,
  latencyMs: number,
  success: boolean,
  ctx: UsageContext,
): UsageEvent {
  return {
    userId: ctx.userId,
    conversationId: ctx.conversationId,
    provider,
    model,
    action,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cachedInputTokens: usage.cachedInputTokens ?? 0,
    costUsd: estimateCostUsd(provider, model, usage),
    latencyMs,
    success,
    createdAt: new Date().toISOString(),
  };
}
