-- Avatar upload was rejected with 403 "new row violates row-level security policy".
--
-- The storage policies compare the first path segment to `auth.uid()::text`, which Postgres renders
-- LOWERCASE, but the iOS client built the path from Swift's `UUID.uuidString` — UPPERCASE. So
-- `avatars/DD0044E3-…/avatar.jpg` never matched and every avatar save failed.
--
-- The client now lowercases the path, but shipped builds (≤ 1.0.3) do not, so compare
-- case-insensitively here as well: that repairs avatar upload for installed apps without an update.

drop policy if exists "avatars write own" on storage.objects;
drop policy if exists "avatars update own" on storage.objects;
drop policy if exists "avatars delete own" on storage.objects;

create policy "avatars write own" on storage.objects
  for insert with check (bucket_id = 'avatars' and lower((storage.foldername(name))[1]) = auth.uid()::text);
create policy "avatars update own" on storage.objects
  for update using (bucket_id = 'avatars' and lower((storage.foldername(name))[1]) = auth.uid()::text);
create policy "avatars delete own" on storage.objects
  for delete using (bucket_id = 'avatars' and lower((storage.foldername(name))[1]) = auth.uid()::text);
