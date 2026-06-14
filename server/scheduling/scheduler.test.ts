import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scheduleTask, dayWindow, type PlacedBlock } from './scheduler.ts';
import { type Interval } from './freeSlots.ts';

const DAY = Date.UTC(2026, 5, 15); // 2026-06-15T00:00:00Z as the day origin
const at = (min: number) => DAY + min * 60_000;
const min = (ms: number) => Math.round((ms - DAY) / 60_000);

// A typical day: awake 07:00–23:00, with work 09:00–17:00 and lunch 12:30–13:00 busy.
const availability: Interval[] = [dayWindow(DAY, 7 * 60, 23 * 60)];
const busy: Interval[] = [
  dayWindow(DAY, 9 * 60, 17 * 60),       // work
  dayWindow(DAY, 12 * 60 + 30, 13 * 60), // lunch (inside work, harmless)
];

test('places a 45-min task into the first free slot of the day', () => {
  const p = scheduleTask(availability, busy, { durationMin: 45 });
  assert.equal(p.ok, true);
  if (!p.ok) return;
  assert.equal(p.blocks.length, 1);
  // morning gap is 07:00–09:00 → task lands at 07:00
  assert.equal(min(p.blocks[0].start), 7 * 60);
  assert.equal(min(p.blocks[0].end), 7 * 60 + 45);
});

test('inserts a commute block before a task at a location', () => {
  const p = scheduleTask(availability, busy, { durationMin: 60, commuteMin: 25, earliestStart: at(17 * 60) });
  assert.equal(p.ok, true);
  if (!p.ok) return;
  const kinds = p.blocks.map((b: PlacedBlock) => b.kind);
  assert.deepEqual(kinds, ['commute', 'task']);
  assert.equal(min(p.blocks[0].start), 17 * 60);        // commute starts at 17:00
  assert.equal(min(p.blocks[0].end), 17 * 60 + 25);     // 25-min commute
  assert.equal(min(p.blocks[1].start), 17 * 60 + 25);   // task right after
  assert.equal(min(p.blocks[1].end), 17 * 60 + 25 + 60);
});

test('respects a deadline by failing when nothing fits in time', () => {
  // Only the morning gap (07:00–09:00) is before the deadline; a 3h task cannot fit.
  const p = scheduleTask(availability, busy, { durationMin: 180, deadline: at(9 * 60) });
  assert.equal(p.ok, false);
});

test('splits a multi-session task across the day', () => {
  // 3h of focused work in 1h sessions: morning (07–09 → one 1h) + evening (17–23 → two 1h)
  const p = scheduleTask(availability, busy, { durationMin: 180, sessionMin: 60 });
  assert.equal(p.ok, true);
  if (!p.ok) return;
  assert.equal(p.blocks.length, 3);
  assert.ok(p.blocks.every((b) => b.kind === 'task'));
});

test('returns no_slot when the day is full', () => {
  const fullyBusy: Interval[] = [dayWindow(DAY, 7 * 60, 23 * 60)];
  const p = scheduleTask(availability, fullyBusy, { durationMin: 30 });
  assert.equal(p.ok, false);
});
