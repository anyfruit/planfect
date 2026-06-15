-- A semantic category for scheduled blocks (work / fitness / meal / leisure / …) so the app can
-- show meaningful types and icons instead of a generic "Task". Null = uncategorized (legacy/derived).
alter table time_blocks add column if not exists category text;
