# AI Providers — multi-provider strategy

Planfect's planner is **provider-agnostic**. The AI is reached only through the
`PlannerLLM` interface, so OpenAI, Anthropic, and Qwen (and others) are interchangeable —
switching or A/B-testing is a config change, never a rewrite. This supports using whichever
credit/model is best (the developer has both OpenAI and Anthropic credit) and trying
domestic Chinese models like Qwen.

## The contract

`server/llm/types.ts` defines `PlannerLLM`:

```ts
interface PlannerLLM {
  provider: 'openai' | 'anthropic' | 'qwen';
  step(input: { system, messages, tools, model }): Promise<LLMStepResult>;
}
```

The planner loop (`server/planner.ts`) only knows this interface. Tools are defined once,
provider-neutrally (`server/llm/tools.ts`); each adapter converts them to the vendor format.

## Adapters (`server/llm/providers.ts`)

`createPlanner(provider, { apiKey, baseURL? })` returns the right adapter:

| Provider | API shape | Notes |
|---|---|---|
| **OpenAI** | Chat Completions + function calling | default; `baseURL` = `api.openai.com/v1` |
| **Qwen** (Alibaba) | **OpenAI-compatible** (DashScope) | reuses the OpenAI adapter, just a different `baseURL` (`dashscope-intl.aliyuncs.com/compatible-mode/v1`) |
| **Anthropic** | Messages API (`tool_use`/`tool_result`) | maps the same tools to Anthropic blocks |

Because Qwen exposes an OpenAI-compatible endpoint, OpenAI and Qwen share one adapter
(`OpenAICompatiblePlanner`); only Anthropic needs its own.

> The network adapters are scaffolds — wire real keys and integration-test before
> production. The pure logic (planner loop, scheduling, usage) is unit-tested via
> `MockPlanner` (`server/llm/mock.ts`).

## Switching & A/B testing

- **Default** provider/model come from env: `ACTIVE_LLM_PROVIDER` + `PLANNER_MODEL`
  (see `.env.example`). The Edge Function reads them and calls `createPlanner(...)`.
- **Per-request override** is trivial (pass a different provider/model) — useful for A/B or
  letting power users pick.
- **Every call is metered.** The planner emits a `UsageEvent` with `provider` + `model` +
  tokens + cost (`server/usage.ts`), persisted to `usage_events`. The dashboard's
  `metrics_model_comparison` view turns that into a real **model-vs-model comparison**
  (calls, tokens, cost, latency, error rate) — so the choice between OpenAI / Anthropic /
  Qwen is data-driven. See `docs/DASHBOARD.md`.

## Pricing

Per-model prices live in `PRICING` (`server/usage.ts`) keyed by `provider:model`
(OpenAI + Anthropic populated as of 2026-06; **Qwen left as TODO — verify before trusting
its cost numbers**). `estimateCostUsd()` returns 0 for unknown models rather than inventing
a cost, so an unpriced model still logs tokens/latency for comparison without fake dollars.

## Recommended starting models

- **Planner loop:** OpenAI **GPT-5.4** (balanced) or **GPT-4.1** (cheaper, strong
  structured outputs). Switch to Anthropic **Claude Opus 4.8 / Sonnet 4.6** to compare.
- **Cheap sub-tasks** (quick parse/classify): GPT-4.1-mini / nano.
- **China:** Qwen via DashScope when targeting in-country users.

## China note

The same abstraction is the China on-ramp: add the Qwen adapter (already scaffolded) and an
Amap `MapsProvider`, and the China build is config + adapters, not a rewrite (see
`docs/DECISIONS.md` ADR-002/004/006).
