// Bridge between stored routines and the scheduling engine: turn a user's recurring routine
// (work/sleep/meals, with weekdays + local wall-clock times) into the timezone-correct
// availability + busy intervals that scheduleTask consumes. Pure (uses Intl for tz math).

import { type Interval } from './freeSlots.ts';
import { type RoutineKind } from '../types.ts';

export interface CalendarDate {
  year: number;
  month: number; // 1–12
  day: number;
}

export interface RoutineInput {
  kind: RoutineKind;
  daysOfWeek: number[]; // 0=Sun … 6=Sat
  startMin: number;     // minutes from local midnight
  endMin: number;       // minutes from local midnight; <= startMin means overnight
  isFlexible: boolean;
}

// --- timezone-aware wall-clock → UTC epoch ms ------------------------------------------

/** The UTC instant whose wall-clock time in `tz` is `date` at `minutes` past midnight. */
export function zonedToUtc(date: CalendarDate, minutes: number, tz: string): number {
  const hour = Math.floor(minutes / 60);
  const minute = minutes % 60;
  const guess = Date.UTC(date.year, date.month - 1, date.day, hour, minute);
  // Subtract the tz offset; refine once to handle DST transitions.
  let utc = guess - tzOffsetMs(guess, tz);
  utc = guess - tzOffsetMs(utc, tz);
  return utc;
}

/** Offset (ms) of `tz` from UTC at the given instant: tzWallClock(utcMs) − utcMs. */
function tzOffsetMs(utcMs: number, tz: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(utcMs));
  const m: Record<string, number> = {};
  for (const p of parts) if (p.type !== 'literal') m[p.type] = Number(p.value);
  const asUTC = Date.UTC(m.year, m.month - 1, m.day, m.hour, m.minute, m.second);
  return asUTC - utcMs;
}

/** Weekday (0=Sun … 6=Sat) of `date` as observed in `tz`. */
export function weekdayInTz(date: CalendarDate, tz: string): number {
  const ms = zonedToUtc(date, 12 * 60, tz); // noon avoids DST edges
  const wd = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short' }).format(new Date(ms));
  return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(wd);
}

function nextDay(date: CalendarDate): CalendarDate {
  const d = new Date(Date.UTC(date.year, date.month - 1, date.day) + 86_400_000);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

// --- routine expansion -----------------------------------------------------------------

export interface RoutineInstance {
  kind: RoutineKind;
  isFlexible: boolean;
  interval: Interval;
}

/** Routine instances that fall on `date` (in tz). Overnight blocks (end ≤ start) extend
 *  into the next day. */
export function routineInstancesForDate(
  routines: RoutineInput[],
  date: CalendarDate,
  tz: string,
): RoutineInstance[] {
  const wd = weekdayInTz(date, tz);
  const out: RoutineInstance[] = [];
  for (const r of routines) {
    if (!r.daysOfWeek.includes(wd)) continue;
    const start = zonedToUtc(date, r.startMin, tz);
    const end = r.endMin > r.startMin
      ? zonedToUtc(date, r.endMin, tz)
      : zonedToUtc(nextDay(date), r.endMin, tz); // overnight (e.g. sleep 23:00 → 07:00)
    out.push({ kind: r.kind, isFlexible: r.isFlexible, interval: { start, end } });
  }
  return out;
}

export interface PlanningWindows {
  availability: Interval[]; // when the user can be scheduled (awake, not asleep)
  busy: Interval[];         // inviolable, non-sleep routine instances to avoid
}

/**
 * Turn a day's routines into the availability + busy intervals scheduleTask consumes.
 * Availability is the awake window (wake time → bedtime); busy is the inviolable, non-sleep
 * routines (work, meals, …). Flexible routines are not treated as hard busy.
 * `defaultAwake` (minutes from midnight) applies when there is no sleep routine that day.
 */
export function planningWindowsForDate(
  routines: RoutineInput[],
  date: CalendarDate,
  tz: string,
  defaultAwake: { fromMin: number; toMin: number } = { fromMin: 7 * 60, toMin: 23 * 60 },
): PlanningWindows {
  const wd = weekdayInTz(date, tz);
  const sleep = routines.find((r) => r.kind === 'sleep' && r.daysOfWeek.includes(wd));
  const fromMin = sleep ? sleep.endMin : defaultAwake.fromMin;   // wake time
  const toMin = sleep ? sleep.startMin : defaultAwake.toMin;     // bedtime

  // Awake window runs wake → bedtime. When bedtime is at/earlier than wake in clock terms it
  // belongs to the NEXT day (e.g. a late sleeper: wake 10:00, bed 01:00) — without this the
  // window would invert to empty and nothing could ever be scheduled.
  const endDate = toMin <= fromMin ? nextDay(date) : date;
  const availability: Interval[] = [{
    start: zonedToUtc(date, fromMin, tz),
    end: zonedToUtc(endDate, toMin, tz),
  }];

  const busy = routineInstancesForDate(routines, date, tz)
    .filter((i) => i.kind !== 'sleep' && !i.isFlexible)
    .map((i) => i.interval);

  return { availability, busy };
}
