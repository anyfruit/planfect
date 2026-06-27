import Foundation

// MARK: - Database rows

struct TimeBlock: Decodable, Identifiable {
    let id: UUID
    let title: String
    let kind: String            // task | routine | commute | buffer
    let status: String
    let transport_mode: String?
    let task_id: UUID?
    let category: String?
    let tasks: NoteRef?         // embedded task note (PostgREST: tasks(notes))
    let is_private: Bool        // friends see this as just "Busy", even close ones
    let tz: String?             // IANA zone this block's wall-clock belongs to (per-event tz; nil = legacy)
    // Dates are parsed ONCE at decode time. (ISO8601DateFormatter is slow; the schedule/insights
    // views read .start/.end hundreds of times per render when sorting/filtering/positioning.)
    let start: Date
    let end: Date

    var isDone: Bool { status == "done" }
    var notes: String { tasks?.notes ?? "" }
    var durationMin: Int { max(5, Int(end.timeIntervalSince(start) / 60)) }
    /// The zone to render this block in: its own stored zone, or the device zone for legacy rows.
    var zone: TimeZone { tz.flatMap(TimeZone.init(identifier:)) ?? .current }

    enum CodingKeys: String, CodingKey {
        case id, title, kind, status, start_at, end_at, transport_mode, task_id, category, tasks, is_private, tz
    }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(UUID.self, forKey: .id)
        title = try c.decode(String.self, forKey: .title)
        kind = try c.decode(String.self, forKey: .kind)
        status = try c.decode(String.self, forKey: .status)
        transport_mode = try c.decodeIfPresent(String.self, forKey: .transport_mode)
        task_id = try c.decodeIfPresent(UUID.self, forKey: .task_id)
        category = try c.decodeIfPresent(String.self, forKey: .category)
        tasks = try c.decodeIfPresent(NoteRef.self, forKey: .tasks)
        is_private = try c.decodeIfPresent(Bool.self, forKey: .is_private) ?? false
        tz = try c.decodeIfPresent(String.self, forKey: .tz)
        start = APIDate.parse(try c.decode(String.self, forKey: .start_at)) ?? .distantPast
        end = APIDate.parse(try c.decode(String.self, forKey: .end_at)) ?? .distantPast
    }
}

struct NoteRef: Decodable { let notes: String? }

struct Preference: Decodable, Identifiable {
    let id: UUID
    let text: String
}

struct RecurringTask: Decodable, Identifiable {
    let id: UUID
    let title: String
    let days_of_week: [Int]
    let start_local: String      // "HH:MM[:SS]"
    let duration_min: Int
}

struct Routine: Decodable, Identifiable {
    let id: UUID
    let label: String
    let kind: String            // work | sleep | meal | commute | custom
    let days_of_week: [Int]
    let start_time: String      // "HH:MM:SS"
    let end_time: String
    let is_flexible: Bool
}

struct RoutineInsert: Encodable {
    let user_id: String
    let label: String
    let kind: String
    let days_of_week: [Int]
    let start_time: String
    let end_time: String
    let is_flexible: Bool
}

// MARK: - Friends

/// A friend, a pending request (either direction), or a search hit — the shape the `friends`
/// edge function returns. Tier fields appear only in the friends list; `relationship` only in search.
struct FriendProfile: Decodable, Identifiable {
    let id: UUID
    let username: String?
    let display_name: String?
    let avatar_url: String?
    let my_tier: String?       // tier I grant them: "friend" | "close"
    let their_tier: String?    // tier they grant me
    let relationship: String?  // search only: none | requested | incoming | friends

    var name: String {
        if let d = display_name, !d.isEmpty { return d }
        if let u = username, !u.isEmpty { return "@\(u)" }
        return String(localized: "Someone")
    }
    var handle: String { username.map { "@\($0)" } ?? "" }
    var isClose: Bool { my_tier == "close" }
    var avatarURL: URL? { avatar_url.flatMap { URL(string: $0) } }
}

struct FriendsList: Decodable {
    let friends: [FriendProfile]
    let incoming: [FriendProfile]
    let outgoing: [FriendProfile]
}

/// The signed-in user's own editable profile fields.
struct MyProfile: Decodable {
    let username: String?
    let display_name: String?
    let avatar_url: String?
    var avatarURL: URL? { avatar_url.flatMap { URL(string: $0) } }
}

/// One block of a friend's schedule from the `friend_schedule` RPC — already blurred by tier on
/// the server (regular friends get title "Busy", category dropped). No row id is returned.
struct FriendBlock: Decodable, Identifiable {
    let start_at: String
    let end_at: String
    let title: String
    let category: String?
    let kind: String
    var id: String { start_at + "|" + title }
    var start: Date { APIDate.parse(start_at) ?? .distantPast }
    var end: Date { APIDate.parse(end_at) ?? .distantPast }
}

// MARK: - /plan request & response

struct PlanRequest: Encodable {
    var text: String? = nil
    var messages: [JSONValue]? = nil
    var conversation_id: String? = nil
    var calendar_busy: [CalendarBusy]? = nil   // real device-calendar events to schedule around
    var device_timezone: String? = nil         // where the user IS now → the session's planning tz
}

struct PlanResponse: Decodable {
    let type: String            // questions | scheduled | message
    let questions: [PlanQuestion]?
    let receipt: Receipt?
    let text: String?
    let messages: [JSONValue]?
}

struct PlanQuestion: Codable, Identifiable {
    let id: String
    let header: String?
    let question: String
    let multi_select: Bool?
    let options: [PlanOption]

    var headerText: String { let h = header ?? ""; return h.isEmpty ? "Quick question" : h }
    var isMulti: Bool { multi_select ?? false }
}

struct PlanOption: Codable, Identifiable, Hashable {
    var id: String { label }
    let label: String
    let description: String?
}

struct Receipt: Codable {
    let summary: String
    let items: [ReceiptItem]
    let assumptions: [String]
}

struct ReceiptItem: Codable, Identifiable {
    var id: String { title + (start ?? "") }
    let title: String
    let start: String?
    let end: String?
    let tz: String?                 // IANA zone the start/end belong to (per-event tz)
    let commute: ReceiptCommute?
    /// The zone to render this item in: its own stored zone, or the device zone as a fallback.
    var zone: TimeZone { tz.flatMap(TimeZone.init(identifier:)) ?? .current }
}

struct ReceiptCommute: Codable {
    let mode: String
    let leaveAt: String
    let durationMin: Int
}

// MARK: - ISO-8601 parsing (PostgREST timestamptz)

enum APIDate {
    private static let withFractional: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter(); f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]; return f
    }()
    private static let plain: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter(); f.formatOptions = [.withInternetDateTime]; return f
    }()
    static func parse(_ s: String) -> Date? {
        plain.date(from: s) ?? withFractional.date(from: s)
    }
    static func iso(_ d: Date) -> String { plain.string(from: d) }
}

// MARK: - Per-event timezone formatting
//
// A block/receipt item is rendered at the WALL-CLOCK time of the zone it was planned in, NOT the
// device's current zone — so a "3pm" plan made on a California trip keeps showing 3pm after the user
// flies home. Formatters are cached per zone because the schedule re-renders these many times a frame.
enum ZonedFormat {
    private static var timeCache: [String: DateFormatter] = [:]
    private static var dayCache: [String: DateFormatter] = [:]

    /// Short time ("3:00 PM" / "15:00" per locale) in `zone`.
    static func time(_ d: Date, _ zone: TimeZone) -> String {
        cached(&timeCache, zone) { $0.timeStyle = .short }.string(from: d)
    }
    /// Full day ("Sunday, Jun 28", localized) in `zone`.
    static func dayFull(_ d: Date, _ zone: TimeZone) -> String {
        cached(&dayCache, zone) { $0.setLocalizedDateFormatFromTemplate("EEEEMMMd") }.string(from: d)
    }
    /// A short zone tag ("PDT") to disambiguate when a block isn't in the device's current zone;
    /// nil when it matches, so same-zone plans show no clutter.
    static func zoneHint(_ d: Date, _ zone: TimeZone) -> String? {
        guard zone.identifier != TimeZone.current.identifier else { return nil }
        return zone.abbreviation(for: d)
    }
    private static func cached(_ cache: inout [String: DateFormatter], _ zone: TimeZone,
                               _ configure: (DateFormatter) -> Void) -> DateFormatter {
        if let f = cache[zone.identifier] { return f }
        let f = DateFormatter(); f.timeZone = zone; configure(f)
        cache[zone.identifier] = f
        return f
    }
}

// MARK: - Type-erased JSON (faithful round-trip of /plan `messages` for the resume flow)

enum JSONValue: Codable {
    case null
    case bool(Bool)
    case number(Double)
    case string(String)
    case array([JSONValue])
    case object([String: JSONValue])

    init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() { self = .null }
        else if let b = try? c.decode(Bool.self) { self = .bool(b) }
        else if let n = try? c.decode(Double.self) { self = .number(n) }
        else if let s = try? c.decode(String.self) { self = .string(s) }
        else if let a = try? c.decode([JSONValue].self) { self = .array(a) }
        else if let o = try? c.decode([String: JSONValue].self) { self = .object(o) }
        else { throw DecodingError.dataCorruptedError(in: c, debugDescription: "Unsupported JSON") }
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .null: try c.encodeNil()
        case .bool(let b): try c.encode(b)
        case .number(let n): try c.encode(n)
        case .string(let s): try c.encode(s)
        case .array(let a): try c.encode(a)
        case .object(let o): try c.encode(o)
        }
    }

    var object: [String: JSONValue]? { if case .object(let o) = self { return o }; return nil }
    var array: [JSONValue]? { if case .array(let a) = self { return a }; return nil }
    var string: String? { if case .string(let s) = self { return s }; return nil }

    /// The id of the `ask_user_questions` tool call in a returned messages array, so the
    /// answer (a tool result) can reference it on resume.
    static func askToolCallId(in messages: [JSONValue]) -> String? {
        for m in messages.reversed() {
            guard let obj = m.object, obj["role"]?.string == "assistant",
                  let calls = obj["toolCalls"]?.array else { continue }
            for call in calls where call.object?["name"]?.string == "ask_user_questions" {
                return call.object?["id"]?.string
            }
        }
        return nil
    }

    func jsonString() -> String {
        guard let data = try? JSONEncoder().encode(self), let s = String(data: data, encoding: .utf8) else { return "{}" }
        return s
    }
}
