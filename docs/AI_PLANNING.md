# AI Planning — the conversational planner

This is the brain of Planfect: it turns a free-text/voice message into a concrete schedule,
asking multiple-choice clarifying questions when unsure. It runs **server-side** in the
`/plan` Edge Function, behind the `PlannerLLM` abstraction. **Default provider: OpenAI GPT.**

> Provider note: the AI is accessed through one interface (`PlannerLLM`) so OpenAI can be
> swapped for Claude (or A/B-tested) without changing app or scheduling code. This doc
> describes the OpenAI (function-calling) implementation; an Anthropic adapter would map the
> same tools to Anthropic tool-use. See `DECISIONS.md` ADR-004.

## The agent loop

```
user message ─▶ /plan
                 │
                 ▼
   load context: profile, routines, saved locations,
   upcoming time_blocks, recent messages
                 │
                 ▼
   ┌──────────────────────────────────────────────┐
   │  call PlannerLLM with system + messages + tools│◀───────────┐
   └───────────────┬──────────────────────────────┘            │
                   │                                            │
        model wants a tool?                                     │
          ├── ask_user_questions ─▶ RETURN questions to app ────┘ (resume next request
          │                          (interrupt: human in the loop)   with the answer)
          ├── geocode_place      ─▶ MapsProvider.geocode    ─┐
          ├── estimate_commute   ─▶ MapsProvider.directions  │  fulfill server-side,
          ├── get_schedule       ─▶ query time_blocks        │  append tool result,
          ├── schedule_tasks     ─▶ write tasks + time_blocks │  loop again
          └── update_task        ─▶ update rows              ─┘
                   │
        model returns final text/receipt
                   │
                   ▼
   persist messages + blocks ─▶ return { type: "scheduled", receipt, blocks }
```

The loop is the standard "tool-calling agent": call the model, fulfill any tool calls,
feed results back, repeat until the model stops calling tools. The one twist is
`ask_user_questions`, which **pauses** the loop for human input (below).

## Tools (OpenAI function calling, `strict: true`)

All tools are JSON-Schema functions with `strict: true` so the arguments are guaranteed
valid. Server-fulfilled tools run inside the Edge Function; the one interrupt tool is
returned to the app.

### `ask_user_questions` — the multiple-choice clarifying questions (interrupt tool)

This is the "Claude-style" clarifying-question mechanism. When the model is unsure about a
**consequential** ambiguity (duration, which day, which of two locations, single vs.
recurring…), it calls this instead of guessing.

```jsonc
{
  "name": "ask_user_questions",
  "description": "Ask the user 1–3 quick multiple-choice questions when a consequential detail is ambiguous. Prefer this over guessing on things that materially change the schedule (durations, dates, locations, recurrence).",
  "strict": true,
  "parameters": {
    "type": "object",
    "additionalProperties": false,
    "properties": {
      "questions": {
        "type": "array",
        "items": {
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "id":          { "type": "string", "description": "stable id to map the answer back" },
            "header":      { "type": "string", "description": "≤12-char chip label, e.g. 'Duration'" },
            "question":    { "type": "string" },
            "multi_select":{ "type": "boolean" },
            "options": {
              "type": "array",
              "items": {
                "type": "object",
                "additionalProperties": false,
                "properties": {
                  "label":       { "type": "string" },
                  "description": { "type": "string" }
                },
                "required": ["label", "description"]
              }
            }
          },
          "required": ["id", "header", "question", "multi_select", "options"]
        }
      }
    },
    "required": ["questions"]
  }
}
```

**How the interrupt works (human in the loop):**
1. The model emits an `ask_user_questions` tool call.
2. The Edge Function does **not** fulfill it. It persists the in-progress message state
   (including the assistant tool call) and returns `{ type: "questions", questions: [...] }`.
3. The app renders each question as a card: the options **plus an always-present "Other"**
   that opens free-text input. ("Other" is a UI affordance — the model never has to emit
   it.) Single- or multi-select per `multi_select`.
4. The user answers. The app calls `/plan` again with the answers.
5. The Edge Function appends a `tool` message (`tool_call_id` = the original call, content =
   the user's selections / free text) and re-invokes the model. The loop resumes exactly
   where it left off.

> This pause-and-resume is why we persist the conversation's message array in `messages`:
> a planning "turn" can span multiple HTTP requests as questions are answered.

### Server-fulfilled tools (run inside `/plan`)

```jsonc
// Resolve a place mentioned in chat to a real location (creates/finds a locations row)
{ "name": "geocode_place",
  "parameters": { "query": "string (e.g. 'Dr. Lee Dental, downtown')" } }

// Travel time + mode between two locations (via MapsProvider). Used to insert commute blocks.
{ "name": "estimate_commute",
  "parameters": { "from_location_id": "string", "to_location_id": "string",
                  "modes": "array of driving|transit|walking|cycling (optional)",
                  "arrive_by": "string ISO-8601 (optional)" } }

// Read the user's existing schedule (routines materialized + tasks + commute) for a range,
// so the model can find free slots and avoid conflicts.
{ "name": "get_schedule",
  "parameters": { "start": "ISO-8601 date", "end": "ISO-8601 date" } }

// Commit the plan: create/refresh tasks and their time_blocks (incl. commute + buffers).
{ "name": "schedule_tasks",
  "parameters": { "tasks": [ { "title": "...", "estimated_duration_min": 0,
                               "location_id": "string|null", "blocks": [ {"start":"ISO","end":"ISO","kind":"task|commute|buffer"} ] } ] } }

// Modify an existing task/block (reschedule, mark done, change duration).
{ "name": "update_task",
  "parameters": { "task_id": "string", "changes": { } } }
```

(Schemas abbreviated for readability; real definitions use `strict: true` +
`additionalProperties: false`.)

## System prompt (sketch)

Stable prefix (good for prompt caching) → volatile context last:

```
You are Planfect, a calm, precise day-planning assistant.

The user's fixed routine (never schedule on top of inviolable blocks):
{routines}
Saved locations: {locations}
Preferences: timezone {tz}; transport preference {modes}; working hours {workday}.

Rules:
- Estimate durations the user didn't give, using sensible real-world defaults; state the
  assumption in your receipt.
- For any task at a location different from where the user will be, use estimate_commute and
  insert a commute block (and a small buffer) before/after.
- Never place tasks over inviolable routine blocks. Respect earliest_start and deadline.
- Ask (ask_user_questions) before guessing on anything that materially changes the schedule:
  duration, which day, which location, one-off vs recurring. Don't ask about trivia.
- When done, call schedule_tasks, then reply with a short receipt: exactly what you
  scheduled/changed, with times and any commute.

Today is {now} ({tz}). Current upcoming schedule: {time_blocks}.
```

## Message payload shapes (stored in `messages.content` jsonb)

```jsonc
// assistant clarifying-question card
{ "type": "questions", "questions": [ /* same shape as ask_user_questions */ ] }

// user's answer to a card
{ "type": "answers", "answers": [ { "id": "...", "selected": ["..."], "other": "string|null" } ] }

// assistant scheduling receipt
{ "type": "receipt",
  "summary": "Scheduled 3 things.",
  "items": [ { "title": "Dentist", "start": "...", "end": "...",
               "commute": { "mode": "transit", "leave_at": "...", "duration_min": 25 } } ],
  "assumptions": [ "Assumed groceries ≈ 45 min." ] }
```

## Model selection & pricing (OpenAI — figures as of June 2026, verify at integration)

| Model | Input / Output ($ per 1M tok) | Use for |
|---|---|---|
| GPT-5.5 | $5.00 / $30.00 (cached input $0.50) | hardest scheduling / dev quality ceiling |
| **GPT-5.4** | **$2.50 / $15.00** | **recommended default** for the planning loop — strong reasoning, balanced cost |
| GPT-4.1 | $2.00 / $8.00 | cost-optimized default; explicitly strong at structured outputs |
| GPT-4.1 mini | $0.40 / $1.60 | cheap sub-tasks (quick note parsing, classification) |
| GPT-4.1 nano | $0.10 / $0.40 | cheapest extraction/classification |

**Recommendation.** Start the `/plan` loop on **GPT-5.4** (good reasoning at a balanced
price); drop to **GPT-4.1** if you want to cut cost — its structured-output strength fits
this tool-heavy design well. Use **mini/nano** for any cheap pre-parse step. With ~$150 of
credit, a planning turn (~1–3K input + a few hundred output tokens) costs roughly **1–2
cents** — thousands of turns of runway for development and early users; less with caching.

**Cost levers:**
- **Cache the stable prefix** (system + routine + preferences) — GPT-5.x cached input is
  far cheaper than fresh input.
- **Batch API (−50%)** for any non-interactive work (e.g. an optional nightly re-plan),
  not for the live chat.
- Function calling + Structured Outputs are supported across this lineup; the o-series
  reasoning models also support them if deeper reasoning is ever needed.

## `PlannerLLM` interface (Edge Function, Deno/TypeScript)

```ts
export interface PlannerLLM {
  // One step: given the running messages + tool defs, return the model's next move
  // (assistant text, tool calls to fulfill, or a final result).
  step(input: { system: string; messages: LLMMessage[]; tools: ToolDef[] }): Promise<LLMStep>;
}

// Default adapter wraps the OpenAI Chat Completions / Responses API with function calling.
// A future ClaudePlanner maps the same ToolDefs to Anthropic tool-use.
```

The Edge Function owns the loop (fulfilling server tools, handling the `ask_user_questions`
interrupt, persisting state); the `PlannerLLM` adapter only knows how to take one model
step. That keeps providers swappable and the scheduling logic provider-agnostic.

## Build order for this module (see ROADMAP)

1. `get_schedule` + `schedule_tasks` against the DB (no AI) — prove the scheduling writes.
2. The OpenAI `step()` adapter + the loop, with `ask_user_questions` as the only tool.
3. Add `geocode_place` + `estimate_commute` via `MapsProvider`.
4. Tune the system prompt + duration heuristics; add prompt caching.
