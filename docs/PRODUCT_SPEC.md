# Product Spec

Planfect is an AI day planner. The user records what they need to do — by **voice or
text** — and the assistant turns it into a concrete, realistic schedule, accounting for
their fixed daily routine and travel time.

## Core idea

> "I have a dentist appointment Friday afternoon, need to do groceries sometime this
> weekend, and I want to finish the quarterly report this week."

From a message like that, Planfect should:

1. **Extract the tasks** — dentist (fixed-ish time, a place), groceries (flexible, a
   place), finish report (flexible, no place, multi-session).
2. **Estimate durations** it isn't told (groceries ≈ 45 min, report ≈ a few focused hours
   split across days).
3. **Schedule around the user's routine** — never on top of work, sleep, commute, meals.
4. **Compute commute** for anything at a different location — travel time + mode, inserted
   as its own block before/after the task.
5. **Ask when unsure** — a short multiple-choice question (with an "Other" free-text
   option), e.g. "How long is the dentist visit?" → [30 min] [1 hour] [Other].
6. **Confirm** — "Scheduled: Dentist Fri 3:00–4:00 PM, leave home 2:30 PM (transit, 25
   min). Groceries Sat 11:00 AM. Report: 3 × 90-min focus blocks Tue/Wed/Thu mornings."

## The three screens

### 1. Chat (the assistant)

- Conversational input: a text field **and** a mic button (on-device speech-to-text via the
  Speech framework) that transcribes to text.
- The assistant replies in the thread. When it needs to clarify, it renders a
  **multiple-choice card**: a question, 2–4 options each with a short description, and an
  always-present **"Other"** option that opens free-text input. (Same UX as Claude's
  clarifying questions.) Supports single- and multi-select.
- After acting, it posts a **receipt**: a compact summary of exactly what was scheduled /
  changed, with a tap-through to the affected day in the timetable.
- History persists (so the assistant has context and the user can scroll back).

### 2. Timetable (the schedule)

- **Day view** and **Week view** of the scheduled blocks.
- Block types are visually distinct: routine (work/sleep/meal), task, commute, buffer.
- Tap a block → detail (edit time, duration, location; mark done; delete; ask the assistant
  to reschedule).
- Conflicts/overflows are surfaced (e.g., a task that no longer fits).

### 3. Profile (top-right avatar)

- Account: display name, avatar, email / sign-in method.
- **Routine editor** — the recurring life blocks the planner schedules around: work hours,
  commute, sleep, meals. Per weekday. This is what "learns my routine" means concretely:
  the user sets it once (and can refine it), and the planner treats it as fixed background.
- Home & work locations and preferred transport modes (for commute estimates).
- Settings: timezone, notifications, default working hours, units, maps provider (later),
  sign out.

## Key user stories

- *As a user, I can dictate a braid of plans in one voice note and get them all scheduled.*
- *As a user, when the assistant is unsure (duration, which day, which location), it asks
  me a quick tappable question instead of guessing.*
- *As a user, I never get double-booked over my work/sleep/meals.*
- *As a user, anything at a different place automatically gets travel time blocked off,
  with a sensible mode (transit/driving/walking).*
- *As a user, I can see my day and week, and tap any block to adjust it.*
- *As a user, I can set and edit my recurring routine and personal info in my profile.*

## Explicitly out of scope for v1

- Team/shared calendars, multi-person scheduling.
- Deep two-way sync with external calendars (read/write EventKit is a later enhancement;
  v1 keeps its own schedule).
- China market specifics (Amap, WeChat login) — designed-for but not built in v1.
- Android.

## Quality bar / principles

- **Ask, don't silently guess** on consequential ambiguities; guess sensibly on trivial
  ones and state the assumption in the receipt.
- **Always honor the routine** — fixed blocks are inviolable unless the user says otherwise.
- **Be explicit in receipts** — the user should always know what changed and why.
- **Realistic schedules** — include commute and buffers; don't pack things back-to-back
  across town.
