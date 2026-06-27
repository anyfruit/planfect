import Foundation
import WidgetKit

/// Publishes the day's timeline to the App Group so the home/lock-screen widget can render it,
/// then nudges WidgetKit to refresh. Cheap; called on every schedule (re)load.
enum WidgetBridge {
    static func publish(_ blocks: [TimeBlock]) {
        let cal = Calendar.current
        let startOfToday = cal.startOfDay(for: Date())
        let horizon = cal.date(byAdding: .day, value: 2, to: startOfToday) ?? startOfToday  // today + tomorrow

        let tasks = blocks
            .filter { $0.kind != "buffer" }                          // buffers are noise on a small widget
            .filter { $0.end >= startOfToday && $0.start < horizon }
            .sorted { $0.start < $1.start }
            .prefix(50)
            .map { WidgetTask(id: $0.id.uuidString, title: $0.title, start: $0.start, end: $0.end,
                              categoryKey: TaskCategory.bucketKey($0), isDone: $0.isDone, tz: $0.tz) }

        PlanfectWidgetStore.save(Array(tasks))
        WidgetCenter.shared.reloadAllTimelines()
    }
}
