-- Per-event timezone. A time_block already stores an absolute instant (start_at/end_at in UTC),
-- but the app needs to render each block at the WALL-CLOCK time it was planned in, regardless of
-- where the device happens to be now. A user who plans "3pm lunch" while on a trip in California
-- should always see 3pm for it — not have it drift when they fly home (or vice-versa).
--
-- `tz` is the IANA zone the block's wall-clock belongs to (e.g. 'America/Los_Angeles'). It is the
-- planning timezone at the moment the block was created (the device's current zone, or an explicit
-- per-task override the planner set for a trip). NULL = legacy rows planned before this column —
-- clients fall back to the user's profile timezone for those.
alter table time_blocks add column if not exists tz text;

comment on column time_blocks.tz is
  'IANA timezone the block''s wall-clock time belongs to (per-event tz). NULL for legacy rows; clients fall back to the profile timezone.';
