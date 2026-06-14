import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mergeIntervals,
  subtractBusy,
  freeSlots,
  findSlot,
  planSessions,
  type Interval,
} from './freeSlots.ts';

const m = (n: number) => n * 60_000; // minutes → ms

test('mergeIntervals merges overlapping and adjacent', () => {
  const out = mergeIntervals([
    { start: 0, end: m(30) },
    { start: m(30), end: m(60) }, // adjacent
    { start: m(50), end: m(90) }, // overlapping
    { start: m(120), end: m(150) },
  ]);
  assert.deepEqual(out, [
    { start: 0, end: m(90) },
    { start: m(120), end: m(150) },
  ]);
});

test('subtractBusy returns gaps inside the window', () => {
  const free = subtractBusy(
    { start: 0, end: m(120) },
    [{ start: m(30), end: m(60) }],
  );
  assert.deepEqual(free, [
    { start: 0, end: m(30) },
    { start: m(60), end: m(120) },
  ]);
});

test('freeSlots across multiple windows', () => {
  const windows: Interval[] = [
    { start: 0, end: m(60) },
    { start: m(120), end: m(180) },
  ];
  const busy: Interval[] = [{ start: m(10), end: m(20) }];
  assert.deepEqual(freeSlots(windows, busy), [
    { start: 0, end: m(10) },
    { start: m(20), end: m(60) },
    { start: m(120), end: m(180) },
  ]);
});

test('findSlot first-fits and honors the deadline', () => {
  const free: Interval[] = [
    { start: 0, end: m(20) },
    { start: m(60), end: m(180) },
  ];
  // 45 min does not fit in the first 20-min gap → goes to the second slot
  assert.deepEqual(findSlot(free, m(45)), { start: m(60), end: m(105) });
  // deadline before any fitting slot → null
  assert.equal(findSlot(free, m(45), { deadline: m(50) }), null);
});

test('findSlot honors earliestStart', () => {
  const free: Interval[] = [{ start: 0, end: m(120) }];
  assert.deepEqual(findSlot(free, m(30), { earliestStart: m(50) }), {
    start: m(50),
    end: m(80),
  });
});

test('planSessions splits work across slots', () => {
  const free: Interval[] = [
    { start: 0, end: m(60) },
    { start: m(120), end: m(180) },
    { start: m(240), end: m(300) },
  ];
  const res = planSessions(free, m(180), m(60)); // 3h total, 1h sessions
  assert.equal(res.complete, true);
  assert.equal(res.sessions.length, 3);
  assert.deepEqual(res.sessions[0], { start: 0, end: m(60) });
});

test('planSessions reports incomplete when it cannot fit', () => {
  const free: Interval[] = [{ start: 0, end: m(60) }];
  const res = planSessions(free, m(180), m(60));
  assert.equal(res.complete, false);
  assert.equal(res.sessions.length, 1);
});
