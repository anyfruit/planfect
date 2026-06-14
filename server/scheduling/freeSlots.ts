// Pure interval math for scheduling. All times are epoch milliseconds; half-open [start, end).
// No I/O, no dates, no timezones — the Edge Function converts the user's routine + timezone
// into the windows/busy intervals this module operates on. Fully unit-testable.

export interface Interval {
  start: number; // epoch ms, inclusive
  end: number;   // epoch ms, exclusive
}

/** Merge overlapping/adjacent intervals into a minimal sorted set. */
export function mergeIntervals(intervals: Interval[]): Interval[] {
  const sorted = intervals
    .filter((i) => i.end > i.start)
    .sort((a, b) => a.start - b.start);
  const out: Interval[] = [];
  for (const cur of sorted) {
    const last = out[out.length - 1];
    if (last && cur.start <= last.end) {
      last.end = Math.max(last.end, cur.end);
    } else {
      out.push({ start: cur.start, end: cur.end });
    }
  }
  return out;
}

/** The parts of `window` not covered by any `busy` interval. */
export function subtractBusy(window: Interval, busy: Interval[]): Interval[] {
  const merged = mergeIntervals(busy);
  const free: Interval[] = [];
  let cursor = window.start;
  for (const b of merged) {
    if (b.end <= window.start || b.start >= window.end) continue; // outside the window
    const bs = Math.max(b.start, window.start);
    if (bs > cursor) free.push({ start: cursor, end: bs });
    cursor = Math.max(cursor, Math.min(b.end, window.end));
  }
  if (cursor < window.end) free.push({ start: cursor, end: window.end });
  return free;
}

/** Free slots across several availability windows given a set of busy intervals. */
export function freeSlots(windows: Interval[], busy: Interval[]): Interval[] {
  return windows
    .flatMap((w) => subtractBusy(w, busy))
    .filter((i) => i.end > i.start)
    .sort((a, b) => a.start - b.start);
}

export interface FindSlotOptions {
  earliestStart?: number; // task may not start before this
  deadline?: number;      // task must END by this
}

/** First-fit a single block of `durationMs` into the free slots, honoring constraints. */
export function findSlot(
  free: Interval[],
  durationMs: number,
  opts: FindSlotOptions = {},
): Interval | null {
  for (const slot of [...free].sort((a, b) => a.start - b.start)) {
    const start = Math.max(slot.start, opts.earliestStart ?? slot.start);
    const end = start + durationMs;
    if (end <= slot.end && (opts.deadline === undefined || end <= opts.deadline)) {
      return { start, end };
    }
  }
  return null;
}

export interface PlanSessionsResult {
  sessions: Interval[];
  complete: boolean; // true if the full duration was placed
}

/**
 * Split `totalMs` of work into chunks of up to `sessionMs` across the free slots
 * (for multi-session tasks like "finish the report this week"). Greedy, earliest-first.
 */
export function planSessions(
  free: Interval[],
  totalMs: number,
  sessionMs: number,
  opts: FindSlotOptions = {},
): PlanSessionsResult {
  const slots = [...free].sort((a, b) => a.start - b.start).map((s) => ({ ...s }));
  const sessions: Interval[] = [];
  let remaining = totalMs;
  for (const slot of slots) {
    let cursor = Math.max(slot.start, opts.earliestStart ?? slot.start);
    while (remaining > 0) {
      const chunk = Math.min(sessionMs, remaining);
      const end = cursor + chunk;
      if (end <= slot.end && (opts.deadline === undefined || end <= opts.deadline)) {
        sessions.push({ start: cursor, end });
        remaining -= chunk;
        cursor = end;
      } else {
        break;
      }
    }
    if (remaining <= 0) break;
  }
  return { sessions, complete: remaining <= 0 };
}
