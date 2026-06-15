import Foundation
import Supabase

// Data access. The `/plan` agent call goes through the Supabase SDK (Functions attaches the JWT
// correctly). The PostgREST reads/writes go through URLSession with the session's access token
// set explicitly — this is reliable for RLS, whereas the SDK's PostgREST client did not reliably
// attach the user token on calls made right after sign-in. RLS still scopes everything to the user.
extension SupabaseManager {

    /// The signed-in user's access token. Uses the session delivered by `authStateChanges`
    /// (mirrored into `self.session`), waiting briefly for it to populate right after launch —
    /// the SDK's own `client.auth.session` can lag several seconds after sign-in in the simulator.
    func currentToken() async -> String {
        for _ in 0..<25 {
            if let token = try? await client.auth.session.accessToken { return token }  // refreshes if expired
            if let token = session?.accessToken { return token }                        // event-session fallback
            try? await Task.sleep(nanoseconds: 120_000_000)
        }
        return SupabaseConfig.anonKey
    }

    /// Call the `/plan` Edge Function over URLSession with the session JWT. (The SDK's invoke did
    /// not reliably attach the token, causing 401s.)
    func plan(_ request: PlanRequest) async throws -> PlanResponse {
        let token = await currentToken()
        var req = URLRequest(url: URL(string: SupabaseConfig.url.absoluteString + "/functions/v1/plan")!)
        req.httpMethod = "POST"
        req.setValue(SupabaseConfig.anonKey, forHTTPHeaderField: "apikey")
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try JSONEncoder().encode(request)
        let (data, resp) = try await URLSession.shared.data(for: req)
        if let http = resp as? HTTPURLResponse, !(200..<300).contains(http.statusCode) {
            throw NSError(domain: "Planfect.Plan", code: http.statusCode,
                          userInfo: [NSLocalizedDescriptionKey: "Planner unavailable (HTTP \(http.statusCode)). Please try again."])
        }
        return try JSONDecoder().decode(PlanResponse.self, from: data)
    }

    func fetchBlocks() async throws -> [TimeBlock] {
        let data = try await rest("GET", "time_blocks?select=id,title,kind,status,start_at,end_at,transport_mode,category,task_id,tasks(notes)&order=start_at")
        return try JSONDecoder().decode([TimeBlock].self, from: data)
    }

    func setBlockDone(_ id: UUID, _ done: Bool) async throws {
        _ = try await rest("PATCH", "time_blocks?id=eq.\(id.uuidString)",
                           body: try JSONEncoder().encode(["status": done ? "done" : "planned"]), prefer: "return=minimal")
    }

    func rescheduleBlock(_ id: UUID, start: Date, end: Date) async throws {
        _ = try await rest("PATCH", "time_blocks?id=eq.\(id.uuidString)",
                           body: try JSONEncoder().encode(["start_at": start.ISO8601Format(), "end_at": end.ISO8601Format()]),
                           prefer: "return=minimal")
    }

    /// Delete a block. If it belongs to a task, delete the task (cascades its commute/buffer blocks too).
    func deleteBlock(_ block: TimeBlock) async throws {
        if let taskId = block.task_id {
            _ = try await rest("DELETE", "tasks?id=eq.\(taskId.uuidString)")
        } else {
            _ = try await rest("DELETE", "time_blocks?id=eq.\(block.id.uuidString)")
        }
    }

    func setNotes(_ taskId: UUID, _ notes: String) async throws {
        _ = try await rest("PATCH", "tasks?id=eq.\(taskId.uuidString)",
                           body: try JSONEncoder().encode(["notes": notes]), prefer: "return=minimal")
    }

    func fetchRoutines() async throws -> [Routine] {
        let data = try await rest("GET", "routines?select=*&order=start_time")
        return try JSONDecoder().decode([Routine].self, from: data)
    }

    func saveRoutines(_ routines: [RoutineInsert]) async throws {
        _ = try await rest("POST", "routines", body: try JSONEncoder().encode(routines), prefer: "return=minimal")
    }

    func addRoutine(_ r: RoutineInsert) async throws {
        _ = try await rest("POST", "routines", body: try JSONEncoder().encode([r]), prefer: "return=minimal")
    }

    func updateRoutine(_ id: UUID, _ r: RoutineInsert) async throws {
        _ = try await rest("PATCH", "routines?id=eq.\(id.uuidString)", body: try JSONEncoder().encode(r), prefer: "return=minimal")
    }

    func deleteRoutine(_ id: UUID) async throws {
        _ = try await rest("DELETE", "routines?id=eq.\(id.uuidString)")
    }

    /// Set the profile timezone (IANA) so the planner schedules in the user's local time.
    func setTimezone(_ tz: String) async throws {
        guard let uid = userId else { return }
        _ = try await rest("PATCH", "profiles?id=eq.\(uid.uuidString)", body: try JSONEncoder().encode(["timezone": tz]), prefer: "return=minimal")
    }

    /// First-run gate: a user with no routines yet should see onboarding.
    func refreshOnboardingState() async {
        #if DEBUG
        if ProcessInfo.processInfo.environment["PLANFECT_FORCE_ONBOARDING"] == "1" { needsOnboarding = true; return }
        #endif
        do {
            needsOnboarding = try await fetchRoutines().isEmpty
        } catch {
            needsOnboarding = false   // fail open to the main app rather than trapping the user
        }
    }

    // MARK: - PostgREST over URLSession with the user's JWT

    private func rest(_ method: String, _ pathAndQuery: String, body: Data? = nil, prefer: String? = nil) async throws -> Data {
        let token = await currentToken()
        let url = URL(string: SupabaseConfig.url.absoluteString + "/rest/v1/" + pathAndQuery)!
        var req = URLRequest(url: url)
        req.httpMethod = method
        req.setValue(SupabaseConfig.anonKey, forHTTPHeaderField: "apikey")
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if let prefer { req.setValue(prefer, forHTTPHeaderField: "Prefer") }
        req.httpBody = body
        let (data, resp) = try await URLSession.shared.data(for: req)
        if let http = resp as? HTTPURLResponse, !(200..<300).contains(http.statusCode) {
            throw NSError(domain: "Planfect.REST", code: http.statusCode,
                          userInfo: [NSLocalizedDescriptionKey: "HTTP \(http.statusCode)"])
        }
        return data
    }
}
