import Foundation

/// A lightweight schedule item shared from the app to the widget via the App Group container.
/// (Deliberately not TimeBlock — the widget needs none of its decoding/category machinery.)
struct WidgetTask: Codable, Identifiable, Hashable {
    let id: String
    let title: String
    let start: Date
    let end: Date
    let categoryKey: String   // resolved bucket key → CategoryStyle.of(_:)
    let isDone: Bool
    var tz: String? = nil      // IANA zone the start/end belong to (per-event tz; nil = legacy/device)

    /// Render this item in its own planned zone, falling back to the device zone for legacy snapshots.
    var zone: TimeZone { tz.flatMap(TimeZone.init(identifier:)) ?? .current }
}

/// Short time strings rendered in an explicit zone, so the widget matches what the app shows for a
/// plan made in another timezone. Cached per zone (the widget formats these on every refresh).
enum WidgetTimeFormat {
    private static var cache: [String: DateFormatter] = [:]
    private static func formatter(_ zone: TimeZone, _ kind: String) -> DateFormatter {
        let key = "\(kind)|\(zone.identifier)"
        if let f = cache[key] { return f }
        let nf = DateFormatter()
        nf.timeZone = zone
        if kind == "day" { nf.setLocalizedDateFormatFromTemplate("EEE") } else { nf.timeStyle = .short }
        cache[key] = nf
        return nf
    }
    static func short(_ d: Date, _ zone: TimeZone) -> String {
        formatter(zone, "time").string(from: d)
    }
    /// Localized short weekday ("Tue" / "周二") — shown when an item is not on the entry's day.
    static func dayShort(_ d: Date, _ zone: TimeZone) -> String {
        formatter(zone, "day").string(from: d)
    }
}

/// Read/write the day's snapshot in the shared App Group so the widget can render without network.
enum PlanfectWidgetStore {
    static let appGroup = "group.com.planfect.app"
    private static let key = "today_snapshot_v1"
    private static var defaults: UserDefaults? { UserDefaults(suiteName: appGroup) }

    static func save(_ tasks: [WidgetTask]) {
        guard let d = defaults, let data = try? JSONEncoder().encode(tasks) else { return }
        d.set(data, forKey: key)
    }

    static func load() -> [WidgetTask] {
        guard let d = defaults, let data = d.data(forKey: key),
              let tasks = try? JSONDecoder().decode([WidgetTask].self, from: data) else { return [] }
        return tasks
    }
}
