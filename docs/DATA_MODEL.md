# Data Model

The source of truth is Postgres on Supabase. The full DDL (with Row-Level Security) is in
[`../supabase/schema.sql`](../supabase/schema.sql). This doc explains the entities and how
they fit the product.

## Entity map

```
auth.users (Supabase)
   │ 1:1
   ▼
profiles ──── home_location_id / work_location_id ──▶ locations
   │
   │ (all below are owned by a user via user_id, RLS-scoped)
   │
   ├── locations        places the user references
   ├── routines ───────▶ location_id            recurring life blocks (the "routine")
   ├── tasks ──────────▶ location_id            things to get done
   ├── time_blocks ────▶ task_id / routine_id   the materialized schedule (Timetable reads this)
   │                     origin/destination_location_id (for commute blocks)
   └── conversations
          └── messages                          the chat with the assistant
```

## Entities

### `profiles`
1:1 with `auth.users` (auto-created by a trigger on signup). Holds personal info shown on
the Profile screen and the defaults the planner needs: `timezone`, `home_location_id`,
`work_location_id`, `preferred_modes` (ordered commute preference), and a coarse
`workday_start`/`workday_end` hint used before a full routine is configured.

### `locations`
Named places with optional `lat`/`lng` and a provider `place_id` (Apple/Google/Amap).
Created when the user sets home/work or when the planner geocodes a place mentioned in
chat. Tasks, routines, and commute blocks reference locations.

### `routines` — the background the planner schedules **around**
This is what "learns my routine" means concretely. Each row is a recurring life block:
`kind` ∈ work / sleep / meal / commute / custom, `days_of_week` (0=Sun … 6=Sat),
`start_time`–`end_time` (overnight allowed, e.g. sleep 23:00→07:00), optional `location_id`,
and `is_flexible` (default **false** = inviolable). The planner never places a task on top
of an inviolable routine block.

> v1: the user sets these in the Profile → Routine editor. Later, the assistant can propose
> routine edits it infers from conversation.

### `tasks` — what the user wants to get done
`title`, optional `notes`, `estimated_duration_min` (the model fills this in when the user
doesn't say), `status` (pending → scheduled → in_progress → done / cancelled), `priority`,
optional `location_id`, time constraints (`earliest_start`, `deadline`),
`is_multi_session` (can be split into several focus blocks), optional `rrule` (recurrence,
reserved for later), and `source` (chat / voice / manual).

A task is the *intent*; `time_blocks` are the concrete *scheduled instances* of it.

### `time_blocks` — the materialized schedule (what the Timetable renders)
One row per concrete block on the calendar. `kind` distinguishes:
- **task** — a scheduled (possibly partial) task → `task_id` set.
- **routine** — a materialized instance of a routine → `routine_id` set.
- **commute** — a travel leg → `origin_location_id`, `destination_location_id`,
  `transport_mode` set; duration is `end_at - start_at`.
- **buffer** — slack the planner leaves around things.

`start_at`/`end_at` are `timestamptz`; `status` ∈ planned / confirmed / done / skipped.
Indexed by `(user_id, start_at)` for fast day/week range queries.

> **Why materialize routines into blocks?** It makes "find free slots", overlap detection,
> and rendering uniform — the scheduler and the Timetable deal with one block stream
> regardless of whether a block came from a task, a routine, or a commute. Routine blocks
> for a date range can be generated on demand from `routines` (and cached) rather than
> stored forever.

### `conversations` + `messages`
The chat thread(s). `messages.content` is `jsonb` so it can hold:
- plain text turns,
- **clarifying-question cards** (a question + options, rendered as the multiple-choice UI),
- tool calls / tool results from the agent loop,
- scheduling **receipts**.

See [`AI_PLANNING.md`](AI_PLANNING.md) for the exact payload shapes.

## Security: Row-Level Security (RLS)

Every user-owned table has RLS enabled with a policy of `user_id = auth.uid()` (profiles
use `id = auth.uid()`). The Edge Functions derive `user_id` from the verified JWT and never
trust a client-supplied id. Net effect: a user can only ever touch their own data, enforced
at the database layer.

## Typical queries

- **Day view:** `time_blocks` where `start_at` in `[day_start, day_end)` order by `start_at`.
- **Free slots for scheduling:** load that day's routine + task + commute blocks, subtract
  from the user's available window (from `profiles`/`routines`), schedule into the gaps.
- **Assistant context:** the user's `routines`, saved `locations`, upcoming `time_blocks`,
  and the recent `messages` of the conversation — fed into the planner (the routine/profile
  prefix is a good candidate for prompt caching).
