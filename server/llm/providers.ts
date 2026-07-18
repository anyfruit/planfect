// Provider adapters implementing PlannerLLM. Switching providers (or A/B-testing OpenAI vs
// Anthropic vs Qwen) is just `createPlanner(provider, cfg)`.
//
//   - OpenAI and Qwen share the OpenAI Chat Completions wire format (Qwen via Alibaba
//     DashScope's OpenAI-compatible endpoint) → one adapter, different baseURL.
//   - Anthropic uses its Messages API (tool_use / tool_result blocks).
//
// NOTE: these network adapters are scaffolds — wire them to real keys and integration-test
// before production. The pure logic (scheduling, planner loop, usage) is what the unit
// tests cover, via MockPlanner. See docs/AI_PROVIDERS.md.

import {
  type PlannerLLM,
  type LLMProvider,
  type LLMStepInput,
  type LLMStepResult,
  type LLMMessage,
  type ToolCall,
  type FinishReason,
} from './types.ts';

export interface ProviderConfig {
  apiKey: string;
  baseURL?: string;
}

export function createPlanner(provider: LLMProvider, cfg: ProviderConfig): PlannerLLM {
  switch (provider) {
    case 'openai':
      return new OpenAICompatiblePlanner('openai', cfg.apiKey, cfg.baseURL ?? 'https://api.openai.com/v1');
    case 'qwen':
      // DashScope OpenAI-compatible endpoint (use the -intl host outside mainland China).
      return new OpenAICompatiblePlanner('qwen', cfg.apiKey, cfg.baseURL ?? 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1');
    case 'minimax':
      // MiniMax open platform — OpenAI-compatible chat completions. M3 is a reasoning model and
      // wraps its chain-of-thought in <think>…</think> inside content; the adapter strips that.
      return new OpenAICompatiblePlanner('minimax', cfg.apiKey, cfg.baseURL ?? 'https://api.minimaxi.com/v1');
    case 'kimi':
      // Moonshot AI (Kimi) — OpenAI-compatible. This key is a mainland-platform key (api.moonshot.cn);
      // the .ai host is a separate account system. Reasoning models return their chain-of-thought in
      // a separate reasoning_content field, which the adapter already ignores (it reads content).
      return new OpenAICompatiblePlanner('kimi', cfg.apiKey, cfg.baseURL ?? 'https://api.moonshot.cn/v1');
    case 'anthropic':
      return new AnthropicPlanner(cfg.apiKey, cfg.baseURL ?? 'https://api.anthropic.com/v1');
  }
}

// ---------------------------------------------------------------------------
// OpenAI-compatible (OpenAI + Qwen/DashScope)
// ---------------------------------------------------------------------------
class OpenAICompatiblePlanner implements PlannerLLM {
  provider: LLMProvider;
  private apiKey: string;
  private baseURL: string;

  constructor(provider: LLMProvider, apiKey: string, baseURL: string) {
    this.provider = provider;
    this.apiKey = apiKey;
    this.baseURL = baseURL;
  }

  async step(input: LLMStepInput): Promise<LLMStepResult> {
    const body = {
      model: input.model,
      messages: [
        { role: 'system', content: input.system },
        ...input.messages.map(toOpenAIMessage),
      ],
      tools: input.tools.map((t) => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.parameters },
      })),
      tool_choice: 'auto',
    };
    const res = await fetch(`${this.baseURL}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify(body),
    });
    const json = (await res.json()) as any;
    const choice = json.choices?.[0] ?? {};
    const msg = choice.message ?? {};
    const toolCalls: ToolCall[] = (msg.tool_calls ?? []).map((tc: any) => ({
      id: tc.id,
      name: tc.function?.name,
      arguments: safeJson(tc.function?.arguments),
    }));
    return {
      text: stripThink(msg.content),
      toolCalls,
      usage: {
        inputTokens: json.usage?.prompt_tokens ?? 0,
        outputTokens: json.usage?.completion_tokens ?? 0,
        cachedInputTokens: json.usage?.prompt_tokens_details?.cached_tokens ?? 0,
      },
      model: json.model ?? input.model,
      provider: this.provider,
      finishReason: mapFinish(choice.finish_reason),
    };
  }
}

function toOpenAIMessage(m: LLMMessage): any {
  if (m.role === 'tool') {
    return { role: 'tool', tool_call_id: m.toolCallId, content: m.content };
  }
  if (m.role === 'assistant') {
    const out: any = { role: 'assistant', content: m.content };
    if (m.toolCalls && m.toolCalls.length > 0) {
      out.tool_calls = m.toolCalls.map((c) => ({
        id: c.id,
        type: 'function',
        function: { name: c.name, arguments: JSON.stringify(c.arguments) },
      }));
    }
    return out;
  }
  return { role: m.role, content: m.content };
}

// ---------------------------------------------------------------------------
// Anthropic (Messages API)
// ---------------------------------------------------------------------------
class AnthropicPlanner implements PlannerLLM {
  provider: LLMProvider = 'anthropic';
  private apiKey: string;
  private baseURL: string;

  constructor(apiKey: string, baseURL: string) {
    this.apiKey = apiKey;
    this.baseURL = baseURL;
  }

  async step(input: LLMStepInput): Promise<LLMStepResult> {
    const body = {
      model: input.model,
      max_tokens: 4096,
      system: input.system,
      messages: toAnthropicMessages(input.messages),
      tools: input.tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.parameters,
      })),
    };
    const res = await fetch(`${this.baseURL}/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
    });
    const json = (await res.json()) as any;
    const blocks: any[] = json.content ?? [];
    const text = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('');
    const toolCalls: ToolCall[] = blocks
      .filter((b) => b.type === 'tool_use')
      .map((b) => ({ id: b.id, name: b.name, arguments: b.input ?? {} }));
    return {
      text: text || undefined,
      toolCalls,
      usage: {
        inputTokens: json.usage?.input_tokens ?? 0,
        outputTokens: json.usage?.output_tokens ?? 0,
        cachedInputTokens: json.usage?.cache_read_input_tokens ?? 0,
      },
      model: json.model ?? input.model,
      provider: 'anthropic',
      finishReason: json.stop_reason === 'tool_use' ? 'tool_calls' : 'stop',
    };
  }
}

function toAnthropicMessages(messages: LLMMessage[]): any[] {
  return messages.map((m) => {
    if (m.role === 'tool') {
      return { role: 'user', content: [{ type: 'tool_result', tool_use_id: m.toolCallId, content: m.content }] };
    }
    if (m.role === 'assistant') {
      const content: any[] = [];
      if (m.content) content.push({ type: 'text', text: m.content });
      for (const c of m.toolCalls ?? []) content.push({ type: 'tool_use', id: c.id, name: c.name, input: c.arguments });
      return { role: 'assistant', content };
    }
    // 'system' is passed separately on Anthropic; treat any stray one as user context.
    return { role: 'user', content: m.content };
  });
}

// ---------------------------------------------------------------------------
function safeJson(s: unknown): Record<string, unknown> {
  if (typeof s !== 'string') return {};
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
}

/** Reasoning models (e.g. MiniMax M3, some Qwen) wrap chain-of-thought in <think>…</think> inside
 *  the message content. Strip it so the model's private reasoning is never shown to the user or
 *  re-sent in the thread — and a tool-call turn whose content is ONLY reasoning collapses to no
 *  user-facing text. Harmless for providers that never emit the tags. */
export function stripThink(s: string | undefined | null): string | undefined {
  if (!s) return undefined;
  const out = s
    .replace(/<think>[\s\S]*?<\/think>/gi, '')   // well-formed blocks
    .replace(/<think>[\s\S]*$/i, '')             // an unclosed block (output truncated by max_tokens)
    .trim();
  return out.length ? out : undefined;
}

function mapFinish(reason: unknown): FinishReason {
  if (reason === 'tool_calls') return 'tool_calls';
  if (reason === 'stop') return 'stop';
  if (reason === 'length') return 'length';
  return 'other';
}
