import Foundation

// Public client config. The anon key is DESIGNED to ship in the app — it only grants what
// Row-Level Security allows for the signed-in user. The service-role key NEVER appears here;
// it lives solely in Supabase Edge Function secrets on the server.
enum SupabaseConfig {
    static let url = URL(string: "https://piyfhwmrumbexofbjqyu.supabase.co")!
    static let anonKey =
        "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBpeWZod21ydW1iZXhvZmJqcXl1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODE0ODAwOTQsImV4cCI6MjA5NzA1NjA5NH0.3QG9PNI_8hqpxaj_mNyO8lHIO9UTogJiEyoFPqvAUqU"
}
