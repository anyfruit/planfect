// Higher-level placement: fit a task (optionally with a commute leg and buffer, or split
// into multiple sessions) into the user's availability. Pure; operates on epoch-ms intervals.

import {
  type Interval,
  freeSlots,
  findSlot,
  planSessions,
} from './freeSlots.ts';

export interface PlacedBlock {
  kind: 'task' | 'commute' | 'buffer';
  start: number;
  end: number;
}

export interface ScheduleTaskRequest {
  durationMin: number;
  earliestStart?: number;   // epoch ms — don't start before this (soft lower bound for auto placement)
  pinnedStart?: number;     // epoch ms — the TASK itself must start exactly here (an explicit/agreed
                            // time); any commute is placed BEFORE it (you leave early to arrive on time)
  deadline?: number;        // epoch ms (task must end by this)
  sessionMin?: number;      // if set and < durationMin → multi-session (no commute)
  commuteMin?: number;      // travel time to insert as a commute block before the task
  bufferMin?: number;       // slack appended after the task
}

export type Placement =
  | { ok: true; blocks: PlacedBlock[] }
  | { ok: false; reason: 'no_slot' };

/**
 * Place a task into `availability` (windows the user is free to schedule) given `busy`
 * (already-scheduled blocks). Single-session tasks may carry a commute + buffer; multi-
 * session tasks are split across slots.
 */
export function scheduleTask(
  availability: Interval[],
  busy: Interval[],
  req: ScheduleTaskRequest,
): Placement {
  const free = freeSlots(availability, busy);
  const durationMs = req.durationMin * 60_000;
  const opts = { earliestStart: req.earliestStart, deadline: req.deadline };

  // Multi-session: split the work, no commute handling in v1.
  if (req.sessionMin && req.sessionMin < req.durationMin) {
    const { sessions, complete } = planSessions(free, durationMs, req.sessionMin * 60_000, opts);
    if (!complete) return { ok: false, reason: 'no_slot' };
    return { ok: true, blocks: sessions.map((s) => ({ kind: 'task', start: s.start, end: s.end })) };
  }

  // Single session, optionally preceded by a commute and followed by a buffer.
  const commuteMs = (req.commuteMin ?? 0) * 60_000;
  const bufferMs = (req.bufferMin ?? 0) * 60_000;
  const need = commuteMs + durationMs + bufferMs;
  // A pinned start is the TASK's start time (arrival/appointment). The commute precedes it, so the
  // whole block (commute + task + buffer) must begin commuteMs EARLIER — leave early, arrive on time.
  // Without a pin, fall back to the soft earliestStart (commute then task both after it).
  const searchEarliest = req.pinnedStart != null ? req.pinnedStart - commuteMs : req.earliestStart;
  const slot = findSlot(free, need, { earliestStart: searchEarliest, deadline: req.deadline });
  if (!slot) return { ok: false, reason: 'no_slot' };

  const blocks: PlacedBlock[] = [];
  let cursor = slot.start;
  if (commuteMs > 0) {
    blocks.push({ kind: 'commute', start: cursor, end: cursor + commuteMs });
    cursor += commuteMs;
  }
  blocks.push({ kind: 'task', start: cursor, end: cursor + durationMs });
  cursor += durationMs;
  if (bufferMs > 0) {
    blocks.push({ kind: 'buffer', start: cursor, end: cursor + bufferMs });
  }
  return { ok: true, blocks };
}

/** Helper for building a daily availability window from minutes-after-midnight bounds. */
export function dayWindow(dayStartMs: number, fromMin: number, toMin: number): Interval {
  return { start: dayStartMs + fromMin * 60_000, end: dayStartMs + toMin * 60_000 };
}
