// The planner agent loop. Provider-agnostic: it drives a PlannerLLM, fulfills server-side
// tools via injected handlers, handles the `ask_user_questions` interrupt (returning the
// questions to the app), and records a UsageEvent per model step. Pure orchestration with
// all dependencies injected, so it's fully testable with a MockPlanner.

import { type PlannerLLM, type LLMMessage, type ToolDef } from './llm/types.ts';
import { type Question, type Receipt, type ReceiptItem } from './types.ts';
import { type UsageSink, type UsageContext, makeUsageEvent } from './usage.ts';
import {
  TOOL_ASK_USER_QUESTIONS,
  TOOL_SCHEDULE_TASKS,
  TOOL_UPDATE_TASK,
  TOOL_SET_RECURRING,
  TOOL_SET_ROUTINE,
} from './llm/tools.ts';

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
  const msgs: LLMMessage[] = sanitizeThread(messages);
  const scheduledItems: ReceiptItem[] = [];
  const assumptions: string[] = [];
  let scheduled = false;
  let wroteOk = false;   // any calendar write that actually landed this turn (see integrity check)
  let nudged = false;    // the integrity check fires at most once per turn

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
      const placed = scheduledItems.filter((it) => it && it.start != null);
      // Integrity check: the reply CLAIMS a calendar change ("排好了 ✅", "moved", …) but no write
      // actually landed this turn — seen in the wild after an answered confirmation card, where the
      // model skipped the tool call and told the user it was scheduled while the calendar stayed
      // empty. Give it ONE corrective step to really do it (or rephrase honestly); the note stays in
      // the thread as a lasting example. Never triggers when any write succeeded.
      if (!nudged && !wroteOk && placed.length === 0 && claimsCalendarChange(res.text)) {
        nudged = true;
        msgs.push({
          role: 'user',
          content:
            '[Integrity check — automated, the user did NOT see your draft: nothing was written to ' +
            'the calendar this turn (no schedule_tasks / update_task succeeded), but your reply ' +
            'implies a change happened. Either ACTUALLY do it now by calling the right tool with the ' +
            'agreed details, or reply honestly that it is not done. Do not mention this note.]',
        });
        continue;
      }
      if (scheduled) {
        if (placed.length > 0) {
          return { type: 'scheduled', receipt: { summary: res.text ?? '', items: placed, assumptions }, messages: msgs };
        }
        // schedule_tasks ran but nothing actually landed on the calendar — report honestly
        // instead of rendering a green "Scheduled" receipt for an empty plan.
        const reason = assumptions.join(' ').trim();
        const text = (res.text ?? '').trim() || reason ||
          "I couldn't find a spot for that. Want me to put it over the conflicting block, or pick another time?";
        return { type: 'message', text, messages: msgs };
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
      // Track real calendar writes for the integrity check (a success CLAIM with none of these
      // this turn gets bounced back to the model).
      if (call.name === TOOL_UPDATE_TASK || call.name === TOOL_SET_RECURRING || call.name === TOOL_SET_ROUTINE) {
        const parsed = safeParse(result) as { ok?: unknown } | null;
        if (parsed?.ok === true) wroteOk = true;
      }
      msgs.push({ role: 'tool', toolCallId: call.id, content: result });
    }

    // Once tasks actually land on the calendar, the structured receipt IS the reply — return now
    // instead of spending another LLM round-trip on a summary the receipt card never displays.
    // (If nothing placed, fall through so the model can recover or explain on the next step.)
    if (scheduled) {
      const placed = scheduledItems.filter((it) => it && it.start != null);
      if (placed.length > 0) {
        return { type: 'scheduled', receipt: { summary: '', items: placed, assumptions }, messages: msgs };
      }
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

/** Does a final reply read like "the calendar was changed"? (✅ / 已安排 / 排好 / 改到 / scheduled /
 *  booked / moved / deleted, …). Used ONLY to decide whether an integrity re-check is needed when
 *  no write actually landed — a false positive just costs one extra (honest) model step. */
export function claimsCalendarChange(text: string | undefined): boolean {
  if (!text) return false;
  return /✅|已(安排|排|调|改|取消|删|挪|订|定)|安排好|排(好|上)了|(改|调|挪|移)(到|好)|取消了|删(掉|好)?了|定好了|(re)?scheduled|booked|moved (it|to)|deleted|cancell?ed|added to your (calendar|schedule)|all set/i
    .test(text);
}

/** Tool result synthesized for a clarifying question the user never answered (see sanitizeThread). */
const UNANSWERED_TOOL_CALL =
  '(The user did not pick an option — they sent a new message instead. Read their latest message and act on it.)';

/**
 * Repair a client-supplied message thread so it is structurally valid for the provider's tool
 * protocol BEFORE it reaches the model. The chat app replays the WHOLE thread every turn, and the
 * user can leave it malformed in ways the OpenAI/Anthropic APIs reject with a 400:
 *
 *   - bypassing a pending `ask_user_questions` card by typing a NEW message → an assistant tool
 *     call with no following tool result, then a user turn;
 *   - answering that card LATE, after already moving on → a tool result that no longer directly
 *     follows its tool call.
 *
 * Either leaves a dangling tool_use (or an orphan tool_result); the request 400s, the turn throws,
 * and because the app keeps resending the same thread, the WHOLE conversation bricks — the "freeze"
 * a user hits by sending a message before tapping an option. We make the backend tolerant instead:
 * every tool call still open when the next user/assistant turn arrives gets a synthetic result, and
 * any tool result with no matching open call is dropped. The repaired thread always satisfies
 * "each assistant tool call is answered, in order, before the conversation continues".
 */
export function sanitizeThread(messages: LLMMessage[]): LLMMessage[] {
  const out: LLMMessage[] = [];
  const openIds: string[] = [];   // tool-call ids still awaiting a result, in call order

  const closeOpen = () => {
    for (const id of openIds) out.push({ role: 'tool', toolCallId: id, content: UNANSWERED_TOOL_CALL });
    openIds.length = 0;
  };

  for (const m of messages) {
    if (m.role === 'tool') {
      const i = openIds.indexOf(m.toolCallId);
      if (i === -1) continue;   // orphan result (no open call to answer) — would 400; drop it
      out.push(m);
      openIds.splice(i, 1);
      continue;
    }
    // A user or assistant turn must not appear between a tool call and its result: close any open
    // calls with a synthetic "unanswered" result first, then emit the turn.
    closeOpen();
    out.push(m);
    if (m.role === 'assistant' && m.toolCalls) for (const c of m.toolCalls) openIds.push(c.id);
  }
  closeOpen();   // a thread ending on an unanswered tool call (defensive; normally the app appends next)
  return out;
}
