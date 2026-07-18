import Foundation
import Supabase
import UIKit

private struct PrefInsert: Encodable { let user_id: String; let text: String; let source: String }
private struct ProfilePlaceIds: Decodable { let home_location_id: UUID?; let work_location_id: UUID? }
private struct AddrRow: Decodable { let address: String? }
private struct IdRow: Decodable { let id: UUID }
private struct LocationInsert: Encodable { let user_id: String; let name: String; let address: String }

/// iCalendar (RFC 5545) formatting helpers for the schedule export.
private enum ICS {
    /// UTC instant in iCalendar form, e.g. 20260616T133000Z.
    static let stamp: DateFormatter = {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = TimeZone(identifier: "UTC")
        f.dateFormat = "yyyyMMdd'T'HHmmss'Z'"
        return f
    }()
    /// Local date for filenames, e.g. 2026-06-16.
    static let fileDate: DateFormatter = {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.dateFormat = "yyyy-MM-dd"
        return f
    }()
    /// Escape a TEXT value per RFC 5545 §3.3.11 (backslash, semicolon, comma, newline).
    static func escape(_ s: String) -> String {
        s.replacingOccurrences(of: "\\", with: "\\\\")
         .replacingOccurrences(of: ";", with: "\\;")
         .replacingOccurrences(of: ",", with: "\\,")
         .replacingOccurrences(of: "\r\n", with: "\\n")
         .replacingOccurrences(of: "\n", with: "\\n")
         .replacingOccurrences(of: "\r", with: "\\n")
    }
    /// Fold a content line to ≤75 octets (§3.1). Breaks on character boundaries so multi-byte
    /// text (e.g. Chinese titles) is never split; continuation lines begin with a single space.
    static func fold(_ line: String) -> String {
        guard line.utf8.count > 75 else { return line }
        var out = ""
        var lineBytes = 0
        for ch in line {
            let n = String(ch).utf8.count
            if lineBytes + n > 75 { out += "\r\n "; lineBytes = 1 }
            out.append(ch)
            lineBytes += n
        }
        return out
    }
}

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

    /// Run async network work under a UIKit background-task assertion, so a request the user kicked
    /// off keeps running for the ~30 s iOS grants after they switch apps — instead of being suspended
    /// mid-flight (which surfaced as a "network connection lost" error even when the server finished).
    func withBackgroundTask<T>(_ name: String, _ work: () async throws -> T) async rethrows -> T {
        // The expiration handler releases the assertion when the ~30s grant runs out — without it
        // the watchdog TERMINATES the app mid-request instead of suspending it.
        let holder = BackgroundTaskHolder()
        let id = await UIApplication.shared.beginBackgroundTask(withName: name) { holder.end() }
        await holder.set(id)
        defer { Task { await holder.end() } }
        return try await work()
    }

    /// Call the `/plan` Edge Function over URLSession with the session JWT. (The SDK's invoke did
    /// not reliably attach the token, causing 401s.) Wrapped in a background-task assertion so a plan
    /// the user fired off still completes if they switch apps while waiting.
    func plan(_ request: PlanRequest) async throws -> PlanResponse {
        let token = await currentToken()
        var req = URLRequest(url: URL(string: SupabaseConfig.url.absoluteString + "/functions/v1/plan")!)
        req.httpMethod = "POST"
        req.setValue(SupabaseConfig.anonKey, forHTTPHeaderField: "apikey")
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        // Tell the planner where the user IS right now so it anchors new plans to this zone (per-event
        // timezone). Set centrally so every caller gets it without threading it through each call site.
        var request = request
        request.device_timezone = TimeZone.current.identifier
        req.httpBody = try JSONEncoder().encode(request)
        return try await withBackgroundTask("plan") {
            let (data, resp) = try await URLSession.shared.data(for: req)
            if let http = resp as? HTTPURLResponse, !(200..<300).contains(http.statusCode) {
                throw NSError(domain: "Planfect.Plan", code: http.statusCode,
                              userInfo: [NSLocalizedDescriptionKey: "Planner unavailable (HTTP \(http.statusCode)). Please try again."])
            }
            return try JSONDecoder().decode(PlanResponse.self, from: data)
        }
    }

    /// Ask the `/insights` Edge Function for an AI read of the user's time breakdown.
    func analyzeInsights(_ summary: InsightsSummary) async throws -> String {
        let token = await currentToken()
        var req = URLRequest(url: URL(string: SupabaseConfig.url.absoluteString + "/functions/v1/insights")!)
        req.httpMethod = "POST"
        req.setValue(SupabaseConfig.anonKey, forHTTPHeaderField: "apikey")
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try JSONEncoder().encode(summary)
        struct R: Decodable { let analysis: String? }
        return try await withBackgroundTask("insights") {
            let (data, resp) = try await URLSession.shared.data(for: req)
            if let http = resp as? HTTPURLResponse, !(200..<300).contains(http.statusCode) {
                throw NSError(domain: "Planfect.Insights", code: http.statusCode,
                              userInfo: [NSLocalizedDescriptionKey: "Analysis unavailable (HTTP \(http.statusCode)). Please try again."])
            }
            return (try JSONDecoder().decode(R.self, from: data)).analysis ?? ""
        }
    }

    /// Ask the `/note-tidy` Edge Function to reorganize a task note into clean bullet points
    /// (preserves all info; returns the original text on an empty result).
    func tidyNote(_ text: String, title: String?) async throws -> String {
        guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return text }
        let token = await currentToken()
        var req = URLRequest(url: URL(string: SupabaseConfig.url.absoluteString + "/functions/v1/note-tidy")!)
        req.httpMethod = "POST"
        req.setValue(SupabaseConfig.anonKey, forHTTPHeaderField: "apikey")
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        struct Body: Encodable { let text: String; let title: String? }
        struct R: Decodable { let text: String? }
        req.httpBody = try JSONEncoder().encode(Body(text: text, title: title))
        return try await withBackgroundTask("note-tidy") {
            let (data, resp) = try await URLSession.shared.data(for: req)
            if let http = resp as? HTTPURLResponse, !(200..<300).contains(http.statusCode) {
                throw NSError(domain: "Planfect.NoteTidy", code: http.statusCode,
                              userInfo: [NSLocalizedDescriptionKey: "Cleanup unavailable (HTTP \(http.statusCode)). Please try again."])
            }
            return (try JSONDecoder().decode(R.self, from: data)).text ?? text
        }
    }

    func fetchBlocks() async throws -> [TimeBlock] {
        let data = try await rest("GET", "time_blocks?select=id,title,kind,status,start_at,end_at,transport_mode,category,task_id,is_private,tz,tasks(notes)&order=start_at")
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

    /// Rename a block (and its task, if any, so the name stays in sync everywhere).
    func setBlockTitle(_ blockId: UUID, taskId: UUID?, _ title: String) async throws {
        _ = try await rest("PATCH", "time_blocks?id=eq.\(blockId.uuidString)",
                           body: try JSONEncoder().encode(["title": title]), prefer: "return=minimal")
        if let taskId {
            _ = try await rest("PATCH", "tasks?id=eq.\(taskId.uuidString)",
                               body: try JSONEncoder().encode(["title": title]), prefer: "return=minimal")
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

    // MARK: - Home / Work places (origin for travel-time estimates)

    /// Current Home and Work addresses (resolved through the profile's location pointers).
    func fetchHomeWork() async -> (home: String?, work: String?) {
        guard let uid = userId?.uuidString else { return (nil, nil) }
        guard let data = try? await rest("GET", "profiles?select=home_location_id,work_location_id&id=eq.\(uid)"),
              let row = try? JSONDecoder().decode([ProfilePlaceIds].self, from: data).first else { return (nil, nil) }
        async let h = address(of: row.home_location_id)
        async let w = address(of: row.work_location_id)
        return (await h, await w)
    }

    private func address(of id: UUID?) async -> String? {
        guard let id, let data = try? await rest("GET", "locations?select=address&id=eq.\(id.uuidString)"),
              let row = try? JSONDecoder().decode([AddrRow].self, from: data).first else { return nil }
        return row.address
    }

    /// Save Home and/or Work address. Updates the pointed location in place, else inserts a new
    /// location and points the profile at it. A nil or blank value is left untouched.
    func saveHomeWork(home: String?, work: String?) async throws {
        if let home, !home.trimmingCharacters(in: .whitespaces).isEmpty {
            try await upsertPlace(field: "home_location_id", name: "Home", address: home)
        }
        if let work, !work.trimmingCharacters(in: .whitespaces).isEmpty {
            try await upsertPlace(field: "work_location_id", name: "Work", address: work)
        }
    }

    private func upsertPlace(field: String, name: String, address: String) async throws {
        guard let uid = userId?.uuidString else { return }
        let pdata = try await rest("GET", "profiles?select=home_location_id,work_location_id&id=eq.\(uid)")
        let ids = try? JSONDecoder().decode([ProfilePlaceIds].self, from: pdata).first
        let existing = field == "home_location_id" ? ids?.home_location_id : ids?.work_location_id
        if let existing {
            _ = try await rest("PATCH", "locations?id=eq.\(existing.uuidString)",
                               body: try JSONEncoder().encode(["name": name, "address": address]), prefer: "return=minimal")
            return
        }
        let data = try await rest("POST", "locations",
                                  body: try JSONEncoder().encode([LocationInsert(user_id: uid, name: name, address: address)]),
                                  prefer: "return=representation")
        guard let id = try JSONDecoder().decode([IdRow].self, from: data).first?.id else { return }
        _ = try await rest("PATCH", "profiles?id=eq.\(uid)",
                           body: try JSONEncoder().encode([field: id.uuidString]), prefer: "return=minimal")
    }

    // MARK: - Learned preferences (habit memory)

    func fetchPreferences() async -> [Preference] {
        guard let data = try? await rest("GET", "preferences?select=id,text&order=created_at") else { return [] }
        return (try? JSONDecoder().decode([Preference].self, from: data)) ?? []
    }

    func addPreference(_ text: String) async throws {
        guard let uid = userId?.uuidString else { return }
        _ = try await rest("POST", "preferences",
                           body: try JSONEncoder().encode([PrefInsert(user_id: uid, text: text, source: "user")]),
                           prefer: "return=minimal")
    }

    func deletePreference(_ id: UUID) async throws {
        _ = try await rest("DELETE", "preferences?id=eq.\(id.uuidString)")
    }

    // MARK: - Recurring tasks / habits

    func fetchRecurring() async -> [RecurringTask] {
        guard let data = try? await rest("GET", "recurring_tasks?select=id,title,days_of_week,start_local,duration_min&active=eq.true&order=created_at") else { return [] }
        return (try? JSONDecoder().decode([RecurringTask].self, from: data)) ?? []
    }

    /// Delete a recurring rule — cascades its future occurrences (time_blocks.recurring_id).
    func deleteRecurring(_ id: UUID) async throws {
        _ = try await rest("DELETE", "recurring_tasks?id=eq.\(id.uuidString)")
    }

    // MARK: - Subscription entitlement

    private struct ProRow: Decodable { let is_pro: Bool? }

    func refreshEntitlement() async {
        guard let uid = userId?.uuidString,
              let data = try? await rest("GET", "profiles?select=is_pro&id=eq.\(uid)"),
              let row = try? JSONDecoder().decode([ProRow].self, from: data).first else { return }
        isPro = row.is_pro ?? false
    }

    #if DEBUG
    /// Dev-only: flip the entitlement to test the gated experience before payments are wired.
    func setPro(_ pro: Bool) async {
        guard let uid = userId?.uuidString else { return }
        _ = try? await rest("PATCH", "profiles?id=eq.\(uid)", body: try? JSONEncoder().encode(["is_pro": pro]), prefer: "return=minimal")
        isPro = pro
    }
    #endif

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

    // MARK: - Export (share schedule as .ics, full backup as .json)

    /// Build an iCalendar (.ics) of every scheduled block and write it to a temp file. The result
    /// imports into Apple Calendar, Google Calendar, Outlook — anything that reads iCalendar.
    func exportICS() async throws -> URL {
        let blocks = try await fetchBlocks()
        let now = ICS.stamp.string(from: Date())
        var lines = [
            "BEGIN:VCALENDAR",
            "VERSION:2.0",
            "PRODID:-//Planfect//Planfect iOS//EN",
            "CALSCALE:GREGORIAN",
            "METHOD:PUBLISH",
            "X-WR-CALNAME:Planfect",
        ]
        for b in blocks where b.start != .distantPast && b.end != .distantPast {
            lines += [
                "BEGIN:VEVENT",
                "UID:\(b.id.uuidString)@planfect.app",
                "DTSTAMP:\(now)",
                "DTSTART:\(ICS.stamp.string(from: b.start))",
                "DTEND:\(ICS.stamp.string(from: b.end))",
                "SUMMARY:\(ICS.escape(b.title))",
            ]
            if let cat = b.category, !cat.isEmpty { lines.append("CATEGORIES:\(ICS.escape(cat))") }
            if !b.notes.isEmpty { lines.append("DESCRIPTION:\(ICS.escape(b.notes))") }
            lines.append("STATUS:\(b.isDone ? "CONFIRMED" : "TENTATIVE")")
            lines.append("END:VEVENT")
        }
        lines.append("END:VCALENDAR")
        let text = lines.map(ICS.fold).joined(separator: "\r\n") + "\r\n"
        return try writeTemp(Data(text.utf8), name: "Planfect-\(ICS.fileDate.string(from: Date())).ics")
    }

    /// Build a complete JSON backup of the user's planning data (routines, schedule, learned
    /// preferences, recurring habits) and write it to a temp file for the share sheet.
    func exportJSON() async throws -> URL {
        async let routinesD = rest("GET", "routines?select=label,kind,days_of_week,start_time,end_time,is_flexible&order=start_time")
        async let blocksD   = rest("GET", "time_blocks?select=title,kind,status,start_at,end_at,transport_mode,category,recurring_id&order=start_at")
        async let prefsD    = rest("GET", "preferences?select=text,source,created_at&order=created_at")
        async let recurD    = rest("GET", "recurring_tasks?select=title,days_of_week,start_local,duration_min,active&order=created_at")
        let (rData, bData, pData, recData) = try await (routinesD, blocksD, prefsD, recurD)

        let dec = JSONDecoder()
        func rows(_ d: Data) -> JSONValue { .array((try? dec.decode([JSONValue].self, from: d)) ?? []) }
        let root: [String: JSONValue] = [
            "app": .string("Planfect"),
            "exported_at": .string(APIDate.iso(Date())),
            "schema_version": .number(1),
            "routines": rows(rData),
            "time_blocks": rows(bData),
            "preferences": rows(pData),
            "recurring_tasks": rows(recData),
        ]
        let enc = JSONEncoder()
        enc.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        let data = try enc.encode(JSONValue.object(root))
        return try writeTemp(data, name: "Planfect-backup-\(ICS.fileDate.string(from: Date())).json")
    }

    /// Write bytes to a uniquely-named temp file and return its URL (overwrites a same-day file).
    private func writeTemp(_ data: Data, name: String) throws -> URL {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(name)
        try data.write(to: url, options: .atomic)
        return url
    }

    // MARK: - PostgREST over URLSession with the user's JWT

    func rest(_ method: String, _ pathAndQuery: String, body: Data? = nil, prefer: String? = nil) async throws -> Data {
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


/// Ends a UIKit background task exactly once, from either the normal path or the expiration handler.
private actor BackgroundTaskHolder {
    private var id: UIBackgroundTaskIdentifier = .invalid
    func set(_ new: UIBackgroundTaskIdentifier) { id = new }
    nonisolated func end() { Task { await self.endInternal() } }
    private func endInternal() async {
        guard id != .invalid else { return }
        let ended = id
        id = .invalid
        await MainActor.run { UIApplication.shared.endBackgroundTask(ended) }
    }
}
