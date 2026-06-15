import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  zonedToUtc,
  weekdayInTz,
  routineInstancesForDate,
  planningWindowsForDate,
  type RoutineInput,
} from './routines.ts';
import { scheduleTask } from './scheduler.ts';

const NY = 'America/New_York';
const everyday = [0, 1, 2, 3, 4, 5, 6];

test('zonedToUtc handles EDT (summer) and EST (winter)', () => {
  // 2026-06-15 09:00 EDT (UTC-4) = 13:00 UTC
  assert.equal(zonedToUtc({ year: 2026, month: 6, day: 15 }, 9 * 60, NY), Date.UTC(2026, 5, 15, 13, 0));
  // 2026-01-15 09:00 EST (UTC-5) = 14:00 UTC
  assert.equal(zonedToUtc({ year: 2026, month: 1, day: 15 }, 9 * 60, NY), Date.UTC(2026, 0, 15, 14, 0));
});

test('weekdayInTz returns a valid weekday', () => {
  const wd = weekdayInTz({ year: 2026, month: 6, day: 15 }, NY);
  assert.ok(wd >= 0 && wd <= 6);
});

const routines: RoutineInput[] = [
  { kind: 'sleep', daysOfWeek: everyday, startMin: 23 * 60, endMin: 7 * 60, isFlexible: false },
  { kind: 'work', daysOfWeek: everyday, startMin: 9 * 60, endMin: 17 * 60, isFlexible: false },
  { kind: 'meal', daysOfWeek: everyday, startMin: 12 * 60 + 30, endMin: 13 * 60, isFlexible: false },
];

test('routineInstancesForDate expands routines; overnight sleep spans to next day', () => {
  const inst = routineInstancesForDate(routines, { year: 2026, month: 6, day: 15 }, NY);
  assert.equal(inst.length, 3);
  const sleep = inst.find((i) => i.kind === 'sleep')!;
  assert.ok(sleep.interval.end > sleep.interval.start);
  assert.equal(sleep.interval.end - sleep.interval.start, 8 * 3600 * 1000); // 23:00 → 07:00 = 8h
});

test('days_of_week filtering: empty set yields no instances', () => {
  const none: RoutineInput[] = [{ kind: 'work', daysOfWeek: [], startMin: 9 * 60, endMin: 17 * 60, isFlexible: false }];
  assert.equal(routineInstancesForDate(none, { year: 2026, month: 6, day: 15 }, NY).length, 0);
});

test('planningWindowsForDate + scheduleTask places a task in the morning gap', () => {
  const date = { year: 2026, month: 6, day: 15 };
  const { availability, busy } = planningWindowsForDate(routines, date, NY);
  const p = scheduleTask(availability, busy, { durationMin: 45 });
  assert.equal(p.ok, true);
  if (!p.ok) return;
  // awake 07:00 local (= 11:00 UTC, EDT); morning gap is 07:00–09:00 → task at 07:00 local
  assert.equal(p.blocks[0].start, Date.UTC(2026, 5, 15, 11, 0));
  assert.equal(p.blocks[0].end, Date.UTC(2026, 5, 15, 11, 45));
});

test('late sleeper (same-day sleep 01:00–10:00) gets a forward awake window, not an empty one', () => {
  const late: RoutineInput[] = [{ kind: 'sleep', daysOfWeek: everyday, startMin: 60, endMin: 600, isFlexible: false }];
  const date = { year: 2026, month: 6, day: 16 };
  const { availability } = planningWindowsForDate(late, date, NY);
  assert.equal(availability.length, 1);
  // wake 10:00 EDT (=14:00 UTC, 16th) → bed 01:00 EDT the NEXT day (=05:00 UTC, 17th)
  assert.equal(availability[0].start, Date.UTC(2026, 5, 16, 14, 0));
  assert.equal(availability[0].end, Date.UTC(2026, 5, 17, 5, 0));
  assert.ok(availability[0].end > availability[0].start, 'awake window must move forward in time');
  // a 2h task at 10:00 now fits (previously failed with no_slot)
  const p = scheduleTask(availability, [], { durationMin: 120, earliestStart: zonedToUtc(date, 600, NY) });
  assert.equal(p.ok, true);
});
