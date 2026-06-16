import Foundation
import EventKit

/// Optional two-way Apple Calendar sync (opt-in via Profile). When enabled, Planfect reads the
/// device calendar so the planner schedules AROUND real events, and writes the plans it makes
/// back to the calendar so they show up in Apple Calendar with system alerts.
@MainActor
final class CalendarManager {
    static let shared = CalendarManager()
    private init() {}

    static let syncKey = "planfect.calendarSync"
    var enabled: Bool { UserDefaults.standard.bool(forKey: Self.syncKey) }

    private let store = EKEventStore()

    /// Ask for full calendar access if not yet decided. Returns whether we have it.
    @discardableResult
    func ensureAccess() async -> Bool {
        switch EKEventStore.authorizationStatus(for: .event) {
        case .fullAccess: return true
        case .notDetermined: return (try? await store.requestFullAccessToEvents()) ?? false
        default: return false
        }
    }

    /// Real (timed) calendar events in the next `days`, as busy intervals for the planner to avoid.
    func upcomingBusy(days: Int = 21) async -> [CalendarBusy] {
        guard enabled, await ensureAccess() else { return [] }
        let start = Date()
        guard let end = Calendar.current.date(byAdding: .day, value: days, to: start) else { return [] }
        let pred = store.predicateForEvents(withStart: start, end: end, calendars: nil)
        return store.events(matching: pred)
            .filter { !$0.isAllDay && $0.status != .canceled && $0.startDate != nil && $0.endDate != nil }
            .map { CalendarBusy(start: APIDate.iso($0.startDate), end: APIDate.iso($0.endDate), title: $0.title ?? "Busy") }
    }

    /// Write scheduled plans into the calendar (skips ones already added to avoid duplicates).
    func addPlans(_ items: [ReceiptItem]) async {
        guard enabled, await ensureAccess(), let cal = store.defaultCalendarForNewEvents else { return }
        for item in items {
            guard let start = item.start.flatMap(APIDate.parse), let end = item.end.flatMap(APIDate.parse) else { continue }
            if eventExists(title: item.title, start: start) { continue }
            let ev = EKEvent(eventStore: store)
            ev.title = item.title
            ev.startDate = start
            ev.endDate = end
            ev.notes = "Planned by Planfect ✨"
            ev.calendar = cal
            try? store.save(ev, span: .thisEvent, commit: true)
        }
    }

    private func eventExists(title: String, start: Date) -> Bool {
        let pred = store.predicateForEvents(withStart: start.addingTimeInterval(-60), end: start.addingTimeInterval(60), calendars: nil)
        return store.events(matching: pred).contains { $0.title == title }
    }
}

struct CalendarBusy: Encodable {
    let start: String   // ISO-8601
    let end: String
    let title: String
}
