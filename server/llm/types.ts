// Provider-agnostic LLM contract. Every provider (OpenAI, Anthropic, Qwen, …) implements
// PlannerLLM, so the planner loop and all scheduling logic are provider-independent and
// switching/A-B-testing is a config change. See docs/AI_PROVIDERS.md.

export type LLMProvider = 'openai' | 'anthropic' | 'qwen';

export interface LLMUsage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
}

export interface ToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>; // JSON Schema (provider-neutral; adapters convert)
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export type LLMMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string; toolCalls?: ToolCall[] }
  | { role: 'tool'; toolCallId: string; content: string };

export interface LLMStepInput {
  system: string;
  messages: LLMMessage[];
  tools: ToolDef[];
  model: string;
}

export type FinishReason = 'stop' | 'tool_calls' | 'length' | 'other';

export interface LLMStepResult {
  text?: string;
  toolCalls: ToolCall[]; // empty when the model is not calling tools
  usage: LLMUsage;
  model: string;
  provider: LLMProvider;
  finishReason: FinishReason;
}

/** One step of the agent loop, normalized across providers. */
export interface PlannerLLM {
  provider: LLMProvider;
  step(input: LLMStepInput): Promise<LLMStepResult>;
}
