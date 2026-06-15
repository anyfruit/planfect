import Foundation

// MARK: - Database rows

struct TimeBlock: Decodable, Identifiable {
    let id: UUID
    let title: String
    let kind: String            // task | routine | commute | buffer
    let status: String
    let start_at: String
    let end_at: String
    let transport_mode: String?

    var start: Date { APIDate.parse(start_at) ?? .distantPast }
    var end: Date { APIDate.parse(end_at) ?? .distantPast }
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

// MARK: - /plan request & response

struct PlanRequest: Encodable {
    var text: String? = nil
    var messages: [JSONValue]? = nil
    var conversation_id: String? = nil
}

struct PlanResponse: Decodable {
    let type: String            // questions | scheduled | message
    let questions: [PlanQuestion]?
    let receipt: Receipt?
    let text: String?
    let messages: [JSONValue]?
}

struct PlanQuestion: Decodable, Identifiable {
    let id: String
    let header: String
    let question: String
    let multi_select: Bool
    let options: [PlanOption]
}

struct PlanOption: Decodable, Identifiable, Hashable {
    var id: String { label }
    let label: String
    let description: String
}

struct Receipt: Decodable {
    let summary: String
    let items: [ReceiptItem]
    let assumptions: [String]
}

struct ReceiptItem: Decodable, Identifiable {
    var id: String { title + (start ?? "") }
    let title: String
    let start: String?
    let end: String?
    let commute: ReceiptCommute?
}

struct ReceiptCommute: Decodable {
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
