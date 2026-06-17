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
