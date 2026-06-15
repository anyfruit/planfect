// Provider-neutral tool definitions for the planner. Adapters in providers.ts convert these
// to each vendor's format (OpenAI `function`, Anthropic `tool`, Qwen = OpenAI-compatible).

import { type ToolDef } from './types.ts';

export const TOOL_ASK_USER_QUESTIONS = 'ask_user_questions';
export const TOOL_GEOCODE_PLACE = 'geocode_place';
export const TOOL_ESTIMATE_COMMUTE = 'estimate_commute';
export const TOOL_GET_SCHEDULE = 'get_schedule';
export const TOOL_SCHEDULE_TASKS = 'schedule_tasks';
export const TOOL_UPDATE_TASK = 'update_task';

// The interrupt tool: when the model calls this, the loop returns the questions to the app
// (rendered as multiple-choice cards + an "Other" affordance) instead of fulfilling it.
const askUserQuestions: ToolDef = {
  name: TOOL_ASK_USER_QUESTIONS,
  description:
    'Ask the user 1-3 quick multiple-choice questions when a consequential detail is ambiguous. Prefer this over guessing on things that materially change the schedule (durations, dates, locations, one-off vs recurring). Do not ask about trivia.',
  parameters: {
    type: 'object',
    additionalProperties: false,
    required: ['questions'],
    properties: {
      questions: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['id', 'header', 'question', 'multi_select', 'options'],
          properties: {
            id: { type: 'string', description: 'stable id to map the answer back' },
            header: { type: 'string', description: 'short chip label, e.g. "Duration"' },
            question: { type: 'string' },
            multi_select: { type: 'boolean' },
            options: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['label', 'description'],
                properties: {
                  label: { type: 'string' },
                  description: { type: 'string' },
                },
              },
            },
          },
        },
      },
    },
  },
};

const geocodePlace: ToolDef = {
  name: TOOL_GEOCODE_PLACE,
  description: 'Resolve a place mentioned by the user to a real location (lat/lng + address).',
  parameters: {
    type: 'object',
    additionalProperties: false,
    required: ['query'],
    properties: { query: { type: 'string', description: 'e.g. "Dr. Lee Dental, downtown"' } },
  },
};

const estimateCommute: ToolDef = {
  name: TOOL_ESTIMATE_COMMUTE,
  description: 'Travel time and mode between two locations, to insert a commute block before a task.',
  parameters: {
    type: 'object',
    additionalProperties: false,
    required: ['from_location_id', 'to_location_id'],
    properties: {
      from_location_id: { type: 'string' },
      to_location_id: { type: 'string' },
      arrive_by: { type: 'string', description: 'ISO-8601 (optional)' },
    },
  },
};

const getSchedule: ToolDef = {
  name: TOOL_GET_SCHEDULE,
  description: "Read the user's existing schedule for a date range to find free slots and avoid conflicts.",
  parameters: {
    type: 'object',
    additionalProperties: false,
    required: ['start', 'end'],
    properties: {
      start: { type: 'string', description: 'ISO-8601 date' },
      end: { type: 'string', description: 'ISO-8601 date' },
    },
  },
};

const scheduleTasks: ToolDef = {
  name: TOOL_SCHEDULE_TASKS,
  description:
    "Commit the plan: for each task, place it on the given local date around the user's routine " +
    'and existing blocks, then create the task and its time blocks (incl. commute + buffer). ' +
    'Pass commute_min from a prior estimate_commute when the task is at a location.',
  parameters: {
    type: 'object',
    additionalProperties: false,
    required: ['tasks'],
    properties: {
      tasks: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['title', 'date'],
          properties: {
            title: { type: 'string' },
            date: {
              type: 'string',
              description: 'Local calendar day to schedule on, YYYY-MM-DD (in the user timezone).',
            },
            estimated_duration_min: { type: 'integer', description: 'Minutes; defaults to 60 if omitted.' },
            location_id: { type: ['string', 'null'] },
            commute_min: {
              type: 'integer',
              description: 'Travel minutes to insert as a commute block before the task (from estimate_commute).',
            },
            buffer_min: { type: 'integer', description: 'Slack minutes appended after the task.' },
            session_min: {
              type: 'integer',
              description: 'If set and < duration, split into multiple sessions of this length (no commute).',
            },
            earliest_start: { type: 'string', description: 'ISO-8601; do not start before this.' },
            deadline: { type: 'string', description: 'ISO-8601; the task must end by this.' },
          },
        },
      },
    },
  },
};

const updateTask: ToolDef = {
  name: TOOL_UPDATE_TASK,
  description: 'Modify an existing task/block (reschedule, mark done, change duration).',
  parameters: {
    type: 'object',
    additionalProperties: false,
    required: ['task_id'],
    properties: {
      task_id: { type: 'string' },
      changes: { type: 'object', additionalProperties: true },
    },
  },
};

export const PLANNER_TOOLS: ToolDef[] = [
  askUserQuestions,
  geocodePlace,
  estimateCommute,
  getSchedule,
  scheduleTasks,
  updateTask,
];
