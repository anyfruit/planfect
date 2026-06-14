// End-to-end demo of the planner — runnable on Node, no API keys, no Supabase.
// It wires the REAL scheduling engine to a scripted (mock) model so you can watch the
// full flow: user message -> multiple-choice clarifying question -> answer -> commute +
// schedule -> receipt, with usage accounting. Run:
//
//   node --experimental-strip-types server/demo/planDemo.ts
//
// (The same handlers, backed by Postgres + a real provider, run in supabase/functions/plan.)

import { runPlanner, type PlannerDeps, type ToolHandlers } from '../planner.ts';
import { MockPlanner } from '../llm/mock.ts';
import { MemoryUsageSink } from '../usage.ts';
import {
  PLANNER_TOOLS,
  TOOL_ASK_USER_QUESTIONS,
  TOOL_ESTIMATE_COMMUTE,
  TOOL_SCHEDULE_TASKS,
} from '../llm/tools.ts';
import { type LLMMessage, type LLMStepResult } from '../llm/types.ts';
import { scheduleTask, dayWindow } from '../scheduling/scheduler.ts';
import { type Interval } from '../scheduling/freeSlots.ts';
import { MockMapsProvider } from '../maps/types.ts';

// --- the user's day (in production this comes from routines + timezone) ---
const DAY = Date.UTC(2026, 5, 19); // Fri 2026-06-19
const availability: Interval[] = [dayWindow(DAY, 7 * 60, 23 * 60)]; // awake 07:00–23:00
const busy: Interval[] = [dayWindow(DAY, 9 * 60, 17 * 60)]; // work 09:00–17:00
const iso = (ms: number) => new Date(ms).toISOString();

// --- tool handlers: REAL scheduler + mock maps ---
const maps = new MockMapsProvider();
const handlers: ToolHandlers = {
  [TOOL_ESTIMATE_COMMUTE]: async () => {
    const routes = await maps.directions({ lat: 0, lng: 0 }, { lat: 0, lng: 0 }, ['transit']);
    return JSON.stringify(routes[0]);
  },
  [TOOL_SCHEDULE_TASKS]: () => {
    // Place a 60-min dentist visit with a 25-min commute, after work, using the real engine.
    const p = scheduleTask(availability, busy, {
      durationMin: 60,
      commuteMin: 25,
      earliestStart: DAY + 17 * 60 * 60_000,
    });
    if (!p.ok) return JSON.stringify({ items: [], assumptions: ['No free slot found.'] });
    const task = p.blocks.find((b) => b.kind === 'task')!;
    const commute = p.blocks.find((b) => b.kind === 'commute');
    return JSON.stringify({
      items: [{
        title: 'Dentist',
        start: iso(task.start),
        end: iso(task.end),
        commute: commute
          ? { mode: 'transit', leaveAt: iso(commute.start), durationMin: Math.round((commute.end - commute.start) / 60_000) }
          : undefined,
      }],
      assumptions: ['Assumed a 1-hour visit.', 'Added a 25-min transit commute + nothing after.'],
    });
  },
};

// --- a scripted "model" mimicking the planner's tool-calling decisions ---
function step(p: Partial<LLMStepResult>): LLMStepResult {
  return { text: '', toolCalls: [], usage: { inputTokens: 1200, outputTokens: 300 }, model: 'gpt-5.4', provider: 'openai', finishReason: 'stop', ...p };
}
const script: LLMStepResult[] = [
  step({ finishReason: 'tool_calls', toolCalls: [{ id: 'c1', name: TOOL_ASK_USER_QUESTIONS, arguments: { questions: [{ id: 'q1', header: 'Duration', question: 'How long is the dentist visit?', multiSelect: false, options: [{ label: '30 min', description: 'checkup' }, { label: '1 hour', description: 'with cleaning' }] }] } }] }),
  step({ finishReason: 'tool_calls', toolCalls: [{ id: 'c2', name: TOOL_ESTIMATE_COMMUTE, arguments: { from_location_id: 'home', to_location_id: 'dentist' } }] }),
  step({ finishReason: 'tool_calls', toolCalls: [{ id: 'c3', name: TOOL_SCHEDULE_TASKS, arguments: { tasks: [{ title: 'Dentist' }] } }] }),
  step({ text: 'Done — dentist booked for Friday evening with travel time.', finishReason: 'stop' }),
];

const llm = new MockPlanner(script);
const usage = new MemoryUsageSink();
const deps: PlannerDeps = {
  llm, model: 'gpt-5.4', system: 'You are Planfect.', tools: PLANNER_TOOLS,
  handlers, context: { userId: 'demo-user', conversationId: 'demo' }, usage,
};

console.log('🗣️  User: "Book my dentist Friday afternoon."\n');

const r1 = await runPlanner([{ role: 'user', content: 'Book my dentist Friday afternoon' }], deps);
if (r1.type === 'questions') {
  console.log('🤖 Assistant asks (multiple-choice card):');
  for (const q of r1.questions) {
    console.log(`   [${q.header}] ${q.question}`);
    for (const o of q.options) console.log(`     • ${o.label} — ${o.description}`);
    console.log('     • Other… (free text — always offered by the app)');
  }
}

console.log('\n👉 User taps "1 hour".\n');

const resumed: LLMMessage[] = [
  ...r1.messages,
  { role: 'tool', toolCallId: 'c1', content: JSON.stringify({ answers: [{ id: 'q1', selected: ['1 hour'] }] }) },
];
const r2 = await runPlanner(resumed, deps);
if (r2.type === 'scheduled') {
  console.log('🤖 Assistant receipt:');
  console.log('   ' + r2.receipt.summary);
  for (const it of r2.receipt.items) {
    console.log(`   • ${it.title}: ${it.start} → ${it.end}`);
    if (it.commute) console.log(`     ↳ leave ${it.commute.leaveAt} (${it.commute.mode}, ${it.commute.durationMin} min)`);
  }
  console.log('   assumptions: ' + r2.receipt.assumptions.join(' '));
}

console.log(`\n📊 Usage: ${usage.events.length} model calls, ${usage.totalTokens()} tokens, $${usage.totalCostUsd().toFixed(4)} — provider/model logged per call (→ dashboard).`);
