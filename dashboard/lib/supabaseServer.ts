// Server-side Supabase client for the dashboard. Uses the service-role key (bypasses RLS)
// and must only ever run on the server — this is an internal/admin tool deployed behind
// access control. Never import this from client components.

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

let cached: SupabaseClient | null = null;

export function serverClient(): SupabaseClient {
  if (cached) return cached;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set (server-side).');
  }
  cached = createClient(url, key, { auth: { persistSession: false } });
  return cached;
}
