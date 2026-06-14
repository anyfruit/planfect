// Scripted PlannerLLM for tests and local dev — returns pre-canned steps in order.
// Lets us exercise the full agent loop (incl. the clarifying-question interrupt and
// usage accounting) with no network and no API keys.

import { type PlannerLLM, type LLMProvider, type LLMStepInput, type LLMStepResult } from './types.ts';

export class MockPlanner implements PlannerLLM {
  provider: LLMProvider;
  private script: LLMStepResult[];
  private i = 0;
  public calls: LLMStepInput[] = [];

  constructor(script: LLMStepResult[], provider: LLMProvider = 'openai') {
    this.script = script;
    this.provider = provider;
  }

  async step(input: LLMStepInput): Promise<LLMStepResult> {
    this.calls.push(input);
    if (this.i >= this.script.length) {
      throw new Error('MockPlanner: script exhausted');
    }
    return this.script[this.i++];
  }
}
