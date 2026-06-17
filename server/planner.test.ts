import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runPlanner, type PlannerDeps } from './planner.ts';
import { MockPlanner } from './llm/mock.ts';
import { MemoryUsageSink } from './usage.ts';
import { PLANNER_TOOLS, TOOL_ASK_USER_QUESTIONS, TOOL_SCHEDULE_TASKS } from './llm/tools.ts';
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
