// The planner agent loop. Provider-agnostic: it drives a PlannerLLM, fulfills server-side
// tools via injected handlers, handles the `ask_user_questions` interrupt (returning the
// questions to the app), and records a UsageEvent per model step. Pure orchestration with
// all dependencies injected, so it's fully testable with a MockPlanner.

import { type PlannerLLM, type LLMMessage, type ToolDef } from './llm/types.ts';
import { type Question, type Receipt, type ReceiptItem } from './types.ts';
import { type UsageSink, type UsageContext, makeUsageEvent } from './usage.ts';
import { TOOL_ASK_USER_QUESTIONS, TOOL_SCHEDULE_TASKS } from './llm/tools.ts';

export type ToolHandler = (args: Record<string, unknown>) => Promise<string> | string;
export type ToolHandlers = Record<string, ToolHandler>;

export interface PlannerDeps {
  llm: PlannerLLM;
  model: string;
  system: string;
  tools: ToolDef[];
  handlers: ToolHandlers;     // server-fulfilled tools (geocode, commute, get/schedule, …)
  context: UsageContext;      // userId / conversationId for usage events
  usage?: UsageSink;
  now?: () => number;
  maxSteps?: number;
}

export type PlannerResult =
  | { type: 'questions'; questions: Question[]; messages: LLMMessage[] }
  | { type: 'scheduled'; receipt: Receipt; messages: LLMMessage[] }
  | { type: 'message'; text: string; messages: LLMMessage[] };

export async function runPlanner(messages: LLMMessage[], deps: PlannerDeps): Promise<PlannerResult> {
  const now = deps.now ?? (() => Date.now());
  const maxSteps = deps.maxSteps ?? 8;
  const msgs: LLMMessage[] = [...messages];
  const scheduledItems: ReceiptItem[] = [];
  const assumptions: string[] = [];
  let scheduled = false;

  for (let step = 0; step < maxSteps; step++) {
    const t0 = now();
    const res = await deps.llm.step({ system: deps.system, messages: msgs, tools: deps.tools, model: deps.model });

    if (deps.usage) {
      await deps.usage.record(
        makeUsageEvent(res.provider, res.model, 'plan_step', res.usage, now() - t0, true, deps.context),
      );
    }

    msgs.push({ role: 'assistant', content: res.text ?? '', toolCalls: res.toolCalls });

    // No tool calls → the model is done.
    if (res.toolCalls.length === 0) {
      if (scheduled) {
        return { type: 'scheduled', receipt: { summary: res.text ?? '', items: scheduledItems, assumptions }, messages: msgs };
      }
      return { type: 'message', text: res.text ?? '', messages: msgs };
    }

    // Interrupt: the model wants to ask the user — hand the questions to the app.
    const ask = res.toolCalls.find((c) => c.name === TOOL_ASK_USER_QUESTIONS);
    if (ask) {
      const questions = (ask.arguments.questions as Question[] | undefined) ?? [];
      return { type: 'questions', questions, messages: msgs };
    }

    // Fulfill server-side tools and feed the results back.
    for (const call of res.toolCalls) {
      const handler = deps.handlers[call.name];
      let result: string;
      try {
        result = handler ? await handler(call.arguments) : `error: no handler for ${call.name}`;
      } catch (e) {
        result = `error: ${(e as Error).message}`;
      }
      if (call.name === TOOL_SCHEDULE_TASKS) {
        scheduled = true;
        const parsed = safeParse(result);
        if (parsed && Array.isArray(parsed.items)) scheduledItems.push(...(parsed.items as ReceiptItem[]));
        if (parsed && Array.isArray(parsed.assumptions)) assumptions.push(...(parsed.assumptions as string[]));
      }
      msgs.push({ role: 'tool', toolCallId: call.id, content: result });
    }
  }

  return { type: 'message', text: '(reached max planning steps)', messages: msgs };
}

function safeParse(s: string): { items?: unknown; assumptions?: unknown } | null {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
