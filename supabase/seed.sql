-- Planfect — sample data for local testing. Apply AFTER schema.sql (and analytics.sql for
-- the admin row). The profile FK references auth.users, so the auth user must exist first:
-- create one via Supabase Auth (dashboard or `supabase auth`), then put its UUID below.

do $$
declare
  uid     uuid := '00000000-0000-0000-0000-000000000001'; -- <-- replace with a real auth.users id
  home    uuid;
  work    uuid;
  dentist uuid;
begin
  insert into profiles (id, display_name, timezone, workday_start, workday_end)
  values (uid, 'Test User', 'America/New_York', '09:00', '17:00')
  on conflict (id) do nothing;

  insert into locations (user_id, name, address, lat, lng)
    values (uid, 'Home', '1 Home St', 40.7128, -74.0060) returning id into home;
  insert into locations (user_id, name, address, lat, lng)
    values (uid, 'Office', '5 Work Ave', 40.7580, -73.9855) returning id into work;
  insert into locations (user_id, name, address, lat, lng)
    values (uid, 'Dr. Lee Dental', '9 Smile Blvd', 40.7300, -73.9950) returning id into dentist;

  update profiles set home_location_id = home, work_location_id = work where id = uid;

  insert into routines (user_id, label, kind, days_of_week, start_time, end_time, is_flexible) values
    (uid, 'Work',  'work',  '{1,2,3,4,5}',     '09:00', '17:00', false),
    (uid, 'Sleep', 'sleep', '{0,1,2,3,4,5,6}', '23:00', '07:00', false),
    (uid, 'Lunch', 'meal',  '{1,2,3,4,5}',     '12:30', '13:00', false);

  insert into tasks (user_id, title, estimated_duration_min, location_id, source)
    values (uid, 'Dentist checkup', 60, dentist, 'manual');
end $$;

-- Make the test user an admin so the developer dashboard is viewable
-- (requires analytics.sql applied):
-- insert into admins (user_id) values ('00000000-0000-0000-0000-000000000001')
--   on conflict do nothing;
