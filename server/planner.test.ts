import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runPlanner, sanitizeThread, claimsCalendarChange, claimsSystemFailure, type PlannerDeps } from './planner.ts';
import { MockPlanner } from './llm/mock.ts';
import { MemoryUsageSink } from './usage.ts';
import { PLANNER_TOOLS, TOOL_ASK_USER_QUESTIONS, TOOL_SCHEDULE_TASKS, TOOL_UPDATE_TASK } from './llm/tools.ts';
import { type LLMMessage, type LLMStepResult } from './llm/types.ts';

function step(partial: Partial<LLMStepResult>): LLMStepResult {
  return {
    text: '',
    toolCalls: [],
    usage: { inputTokens: 100, outputTokens: 50 },
    model: 'gpt-5.4',
    provider: 'openai',
    finishReason: 'stop',
    ...partial,
  };
}

test('planner asks a clarifying question, then schedules on resume; usage is recorded', async () => {
  const script: LLMStepResult[] = [
    // 1. model asks a multiple-choice question (interrupt)
    step({
      finishReason: 'tool_calls',
      toolCalls: [{
        id: 'c1',
        name: TOOL_ASK_USER_QUESTIONS,
        arguments: {
          questions: [{
            id: 'q1', header: 'Duration', question: 'How long is the dentist visit?',
            multiSelect: false,
            options: [
              { label: '30 min', description: 'checkup' },
              { label: '1 hour', description: 'with cleaning' },
            ],
          }],
        },
      }],
    }),
    // 2. after the answer, the model commits the schedule — the planner returns the receipt right
    //    here, with no extra "summary" round-trip (the card renders structured items, not prose).
    step({
      finishReason: 'tool_calls',
      toolCalls: [{ id: 'c2', name: TOOL_SCHEDULE_TASKS, arguments: { tasks: [{ title: 'Dentist' }] } }],
    }),
  ];

  const llm = new MockPlanner(script);
  const usage = new MemoryUsageSink();
  const deps: PlannerDeps = {
    llm,
    model: 'gpt-5.4',
    system: 'You are Planfect.',
    tools: PLANNER_TOOLS,
    handlers: {
      [TOOL_SCHEDULE_TASKS]: () =>
        JSON.stringify({
          items: [{ title: 'Dentist', start: '2026-06-19T15:00:00Z', end: '2026-06-19T16:00:00Z' }],
          assumptions: ['Assumed a 1-hour visit.'],
        }),
    },
    context: { userId: 'u1', conversationId: 'conv1' },
    usage,
  };

  // Phase 1: the model asks → loop returns the questions to the app.
  const r1 = await runPlanner([{ role: 'user', content: 'Book my dentist Friday afternoon' }], deps);
  assert.equal(r1.type, 'questions');
  if (r1.type === 'questions') {
    assert.equal(r1.questions.length, 1);
    assert.equal(r1.questions[0].header, 'Duration');
  }

  // Phase 2: user answered → resume with the answer as a tool result.
  const resumed: LLMMessage[] = [
    ...r1.messages,
    { role: 'tool', toolCallId: 'c1', content: JSON.stringify({ answers: [{ id: 'q1', selected: ['1 hour'] }] }) },
  ];
  const r2 = await runPlanner(resumed, deps);
  assert.equal(r2.type, 'scheduled');
  if (r2.type === 'scheduled') {
    assert.equal(r2.receipt.items.length, 1);
    assert.equal(r2.receipt.items[0].title, 'Dentist');
    assert.deepEqual(r2.receipt.assumptions, ['Assumed a 1-hour visit.']);
    assert.equal(r2.receipt.summary, '');   // no prose summary — the card shows structured items
  }

  // One usage event per model step: 1 (ask) + 1 (schedule) = 2. The schedule short-circuits
  // straight to the receipt, so there's no third "summary" round-trip.
  assert.equal(usage.events.length, 2);
  assert.ok(usage.totalTokens() > 0);
  assert.equal(usage.events[0].provider, 'openai');
  assert.equal(usage.events[0].action, 'plan_step');
});

test('sanitizeThread: a clean ask→answer thread is left untouched', () => {
  const thread: LLMMessage[] = [
    { role: 'user', content: 'Book my dentist' },
    { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: TOOL_ASK_USER_QUESTIONS, arguments: {} }] },
    { role: 'tool', toolCallId: 'c1', content: '{"answers":[]}' },
  ];
  assert.deepEqual(sanitizeThread(thread), thread);
});

test('sanitizeThread: free text after a pending question gets a synthetic result (no dangling tool call)', () => {
  // The freeze repro: a question card is showing, the user types a NEW message instead of tapping.
  const thread: LLMMessage[] = [
    { role: 'user', content: 'Plan my trip' },
    { role: 'assistant', content: 'Which day?', toolCalls: [{ id: 'c1', name: TOOL_ASK_USER_QUESTIONS, arguments: {} }] },
    { role: 'user', content: 'actually, log the return flight too' },
  ];
  const out = sanitizeThread(thread);
  assert.equal(out.length, 4);
  assert.deepEqual(out[2], { role: 'tool', toolCallId: 'c1', content: out[2].content });
  assert.equal(out[2].role, 'tool');
  assert.equal(out[3].content, 'actually, log the return flight too');
  // Every assistant tool call is now answered before the conversation continues → no 400.
  assertToolCallsAnswered(out);
});

test('sanitizeThread: a late answer to a superseded question is dropped as an orphan', () => {
  // User moved on (got a reply), THEN taps the old card — its tool result no longer follows its call.
  const thread: LLMMessage[] = [
    { role: 'user', content: 'Plan my trip' },
    { role: 'assistant', content: 'Which day?', toolCalls: [{ id: 'c1', name: TOOL_ASK_USER_QUESTIONS, arguments: {} }] },
    { role: 'user', content: 'never mind, log the flight' },
    { role: 'assistant', content: 'Logged the flight.' },
    { role: 'tool', toolCallId: 'c1', content: '{"answers":[{"id":"q1","selected":["Today"]}]}' },
  ];
  const out = sanitizeThread(thread);
  // c1 was already closed by the synthetic result before the user's "never mind"; the late real
  // answer is an orphan and is dropped, so the trailing tool message can't 400.
  assert.equal(out.filter((m) => m.role === 'tool' && m.toolCallId === 'c1').length, 1);
  assert.equal(out[out.length - 1].role, 'assistant');
  assertToolCallsAnswered(out);
});

/** Asserts the provider invariant: each assistant tool call is immediately followed by tool
 * results for every one of its ids, before any later user/assistant turn. */
function assertToolCallsAnswered(msgs: LLMMessage[]): void {
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    if (m.role !== 'assistant' || !m.toolCalls?.length) continue;
    const pending = new Set(m.toolCalls.map((c) => c.id));
    let j = i + 1;
    while (j < msgs.length && msgs[j].role === 'tool') {
      pending.delete((msgs[j] as { toolCallId: string }).toolCallId);
      j++;
    }
    assert.equal(pending.size, 0, `assistant tool calls left unanswered: ${[...pending]}`);
  }
}

test('planner returns a plain message when the model just talks', async () => {
  const llm = new MockPlanner([step({ text: 'Your week looks open on Thursday.', finishReason: 'stop' })]);
  const deps: PlannerDeps = {
    llm, model: 'gpt-5.4', system: 'You are Planfect.', tools: PLANNER_TOOLS,
    handlers: {}, context: { userId: 'u1' },
  };
  const r = await runPlanner([{ role: 'user', content: 'How does Thursday look?' }], deps);
  assert.equal(r.type, 'message');
  if (r.type === 'message') assert.match(r.text, /Thursday/);
});

// ---- integrity check: a success CLAIM with no actual write gets bounced back once ----------

test('integrity check: "scheduled ✅" with no write → one corrective step → real schedule lands', async () => {
  // The golf-practice bug: after an answered confirmation, the model REPLIED "排好了" without ever
  // calling schedule_tasks. The guard must hand it one corrective step, after which it commits.
  const script: LLMStepResult[] = [
    step({ text: 'Golf practice 今天 3:00–4:00pm ⛳✅', finishReason: 'stop' }),
    step({
      finishReason: 'tool_calls',
      toolCalls: [{ id: 'c9', name: TOOL_SCHEDULE_TASKS, arguments: { tasks: [{ title: 'Golf practice' }] } }],
    }),
  ];
  const llm = new MockPlanner(script);
  const deps: PlannerDeps = {
    llm, model: 'gpt-5.4', system: 'You are Planfect.', tools: PLANNER_TOOLS,
    handlers: {
      [TOOL_SCHEDULE_TASKS]: () => JSON.stringify({
        items: [{ title: 'Golf practice', start: '2026-07-03T19:00:00Z', end: '2026-07-03T20:00:00Z' }],
        assumptions: [],
      }),
    },
    context: { userId: 'u1' },
  };
  const r = await runPlanner([{ role: 'user', content: '60 分钟就够' }], deps);
  assert.equal(r.type, 'scheduled');
  if (r.type === 'scheduled') assert.equal(r.receipt.items[0].title, 'Golf practice');
  // The corrective note is in the thread (a lasting in-context example against claiming success).
  assert.ok(r.messages.some((m) => m.role === 'user' && String(m.content).startsWith('[Integrity check')));
});

test('integrity check: fires at most once — a repeat offender reply is returned as-is', async () => {
  const script: LLMStepResult[] = [
    step({ text: '已安排好啦 ✅', finishReason: 'stop' }),
    step({ text: '真的已安排好啦 ✅', finishReason: 'stop' }),
  ];
  const llm = new MockPlanner(script);
  const usage = new MemoryUsageSink();
  const deps: PlannerDeps = {
    llm, model: 'gpt-5.4', system: 'You are Planfect.', tools: PLANNER_TOOLS,
    handlers: {}, context: { userId: 'u1' }, usage,
  };
  const r = await runPlanner([{ role: 'user', content: '排一下' }], deps);
  assert.equal(r.type, 'message');
  assert.equal(usage.events.length, 2);   // exactly one extra step, not a loop
});

test('integrity check: does NOT fire when a write actually landed (update_task ok:true)', async () => {
  const script: LLMStepResult[] = [
    step({
      finishReason: 'tool_calls',
      toolCalls: [{ id: 'c1', name: TOOL_UPDATE_TASK, arguments: { task_id: 't1', changes: { start_local: '15:00' } } }],
    }),
    step({ text: '改到 15:00 啦 ✅', finishReason: 'stop' }),
  ];
  const llm = new MockPlanner(script);
  const deps: PlannerDeps = {
    llm, model: 'gpt-5.4', system: 'You are Planfect.', tools: PLANNER_TOOLS,
    handlers: { [TOOL_UPDATE_TASK]: () => JSON.stringify({ ok: true, action: 'rescheduled' }) },
    context: { userId: 'u1' },
  };
  const r = await runPlanner([{ role: 'user', content: '改到下午3点' }], deps);
  assert.equal(r.type, 'message');
  if (r.type === 'message') assert.match(r.text, /15:00/);
  assert.ok(!r.messages.some((m) => m.role === 'user' && String(m.content).startsWith('[Integrity check')));
});

// ---- integrity check: a fabricated "system is broken" refusal with no attempt gets bounced ------

test('integrity check: "系统没反应，加不了" with NO tool attempt → one corrective step → schedule lands', async () => {
  // The interview bug: on a fresh "周一五点有面试" the model refused with an invented outage
  // ("目前系统对周一的更新没有反应，等系统恢复正常再处理？") without calling a single tool — then
  // scheduled the same thing fine seconds later. The guard must hand it one corrective step.
  const script: LLMStepResult[] = [
    step({ text: '这条已经改不动了 😅 后天 15:00 我加不了，目前系统对周一的更新没有反应。要不要先放着，等系统恢复正常再处理？', finishReason: 'stop' }),
    step({
      finishReason: 'tool_calls',
      toolCalls: [{ id: 'c8', name: TOOL_SCHEDULE_TASKS, arguments: { tasks: [{ title: '面试' }] } }],
    }),
  ];
  const llm = new MockPlanner(script);
  const deps: PlannerDeps = {
    llm, model: 'gpt-5.4', system: 'You are Planfect.', tools: PLANNER_TOOLS,
    handlers: {
      [TOOL_SCHEDULE_TASKS]: () => JSON.stringify({
        items: [{ title: '面试', start: '2026-07-20T09:00:00Z', end: '2026-07-20T10:00:00Z' }],
        assumptions: [],
      }),
    },
    context: { userId: 'u1' },
  };
  const r = await runPlanner([{ role: 'user', content: '周一五点有面试' }], deps);
  assert.equal(r.type, 'scheduled');
  if (r.type === 'scheduled') assert.equal(r.receipt.items[0].title, '面试');
  assert.ok(r.messages.some((m) => m.role === 'user' && String(m.content).startsWith('[Integrity check')));
});

test('integrity check: an honest failure report AFTER a real failed attempt is returned as-is', async () => {
  // The model tried update_task, the tool said ok:false, and the reply admits it — that honesty
  // must NOT be bounced (only refusals with zero attempts are).
  const script: LLMStepResult[] = [
    step({
      finishReason: 'tool_calls',
      toolCalls: [{ id: 'c1', name: TOOL_UPDATE_TASK, arguments: { task_id: 'nope', changes: { start_local: '17:00' } } }],
    }),
    step({ text: '这条我改不动 — 没找到对应的日程，能确认下是哪一条吗？', finishReason: 'stop' }),
  ];
  const llm = new MockPlanner(script);
  const usage = new MemoryUsageSink();
  const deps: PlannerDeps = {
    llm, model: 'gpt-5.4', system: 'You are Planfect.', tools: PLANNER_TOOLS,
    handlers: { [TOOL_UPDATE_TASK]: () => JSON.stringify({ ok: false, error: 'no task with that id' }) },
    context: { userId: 'u1' }, usage,
  };
  const r = await runPlanner([{ role: 'user', content: '面试改到五点' }], deps);
  assert.equal(r.type, 'message');
  assert.ok(!r.messages.some((m) => m.role === 'user' && String(m.content).startsWith('[Integrity check')));
  assert.equal(usage.events.length, 2);   // no extra corrective step
});

test('claimsSystemFailure: matches fabricated-outage refusals, passes honest/neutral text', () => {
  for (const t of [
    '目前系统对周一的更新没有反应',
    '这条已经改不动了 😅',
    '我加不了，要不要等系统恢复正常再处理？',
    '暂时无法添加新日程',
    'The system is not responding right now.',
    "I can't add it right now — try again later.",
  ]) {
    assert.equal(claimsSystemFailure(t), true, t);
  }
  for (const t of [
    '面试 周一 17:00–18:00 ✅',
    '今天下午有空吗？',
    '这个我帮不上忙哈 🙂 想安排点什么吗？',
    'Thursday looks open.',
    '那个时段和吃饭冲突，要放 19:00 吗？',
  ]) {
    assert.equal(claimsSystemFailure(t), false, t);
  }
});

test('claimsCalendarChange: matches success claims, passes honest/neutral text', () => {
  for (const t of ['排好了 ✅', '已安排', '改到 15:00 啦', 'Scheduled for Friday 3pm', 'moved it to 4', '已取消']) {
    assert.equal(claimsCalendarChange(t), true, t);
  }
  for (const t of ['今天下午有空吗？', '这个我帮不上忙哈 🙂', '你想排在几点？', 'Thursday looks open.']) {
    assert.equal(claimsCalendarChange(t), false, t);
  }
});
