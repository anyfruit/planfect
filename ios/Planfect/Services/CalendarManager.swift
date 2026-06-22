import Foundation
import EventKit

/// Optional Apple Calendar sync (opt-in via Profile). Planfect reads the device calendar so the
/// planner schedules AROUND real events, and mirrors the plans it makes into a dedicated "Planfect"
/// calendar — kept in sync when you edit or delete a plan in the app (one-way, app → calendar).
/// Every mirrored event carries the block's id in its `url`, so we only ever touch our own events
/// (never the user's), and a later pass can read changes back.
@MainActor
final class CalendarManager {
    static let shared = CalendarManager()
    private init() {}

    static let syncKey = "planfect.calendarSync"
    var enabled: Bool { UserDefaults.standard.bool(forKey: Self.syncKey) }

    private let store = EKEventStore()
    private static let calendarTitle = "Planfect"
    private static let marker = "planfect://block/"

    /// Ask for full calendar access if not yet decided. Returns whether we have it.
    @discardableResult
    func ensureAccess() async -> Bool {
        switch EKEventStore.authorizationStatus(for: .event) {
        case .fullAccess: return true
        case .notDetermined: return (try? await store.requestFullAccessToEvents()) ?? false
        default: return false
        }
    }

    /// Real (timed) calendar events in the next `days`, as busy intervals for the planner to avoid —
    /// EXCLUDING our own Planfect calendar, so the planner never treats its own plans as immovable.
    func upcomingBusy(days: Int = 21) async -> [CalendarBusy] {
        guard enabled, await ensureAccess() else { return [] }
        let start = Date()
        guard let end = Calendar.current.date(byAdding: .day, value: days, to: start) else { return [] }
        let oursId = existingPlanfectCalendar()?.calendarIdentifier
        let cals = store.calendars(for: .event).filter { $0.calendarIdentifier != oursId }
        let pred = store.predicateForEvents(withStart: start, end: end, calendars: cals.isEmpty ? nil : cals)
        return store.events(matching: pred)
            .filter { !$0.isAllDay && $0.status != .canceled && $0.startDate != nil && $0.endDate != nil }
            .map { CalendarBusy(start: APIDate.iso($0.startDate), end: APIDate.iso($0.endDate), title: $0.title ?? "Busy") }
    }

    /// Reconcile the Planfect calendar to the app's task plans: create / update / delete events so
    /// they match `blocks`. Only events tagged with our marker are ever touched. Call this after a
    /// plan and whenever the schedule changes (edit / move / delete).
    func syncToCalendar(_ blocks: [TimeBlock]) async {
        guard enabled, await ensureAccess(), let cal = planfectCalendar() else { return }
        let now = Date()
        // Mirror real task plans only (skip routine / buffer / commute), from ~now forward.
        let wanted = Dictionary(
            blocks.filter { $0.kind == "task" && $0.end > now.addingTimeInterval(-3600) }.map { ($0.id.uuidString, $0) },
            uniquingKeysWith: { a, _ in a })

        let windowStart = now.addingTimeInterval(-3600)
        let windowEnd = Calendar.current.date(byAdding: .day, value: 120, to: now) ?? now.addingTimeInterval(120 * 86_400)
        let pred = store.predicateForEvents(withStart: windowStart, end: windowEnd, calendars: [cal])
        var seen = Set<String>()
        for ev in store.events(matching: pred) {
            guard let bid = blockId(of: ev) else { continue }   // only our own marked events
            seen.insert(bid)
            if let b = wanted[bid] {
                if eventDiffers(ev, from: b) {
                    ev.title = b.title; ev.startDate = b.start; ev.endDate = b.end
                    try? store.save(ev, span: .thisEvent, commit: false)
                }
            } else {
                try? store.remove(ev, span: .thisEvent, commit: false)   // plan gone → drop its event
            }
        }
        for (bid, b) in wanted where !seen.contains(bid) {
            let ev = EKEvent(eventStore: store)
            ev.calendar = cal
            ev.title = b.title
            ev.startDate = b.start
            ev.endDate = b.end
            ev.url = URL(string: Self.marker + bid)
            ev.notes = "Planned by Planfect ✨"
            try? store.save(ev, span: .thisEvent, commit: false)
        }
        try? store.commit()
    }

    // MARK: - helpers

    private func eventDiffers(_ ev: EKEvent, from b: TimeBlock) -> Bool {
        ev.title != b.title
            || abs((ev.startDate ?? .distantPast).timeIntervalSince(b.start)) > 1
            || abs((ev.endDate ?? .distantPast).timeIntervalSince(b.end)) > 1
    }

    private func blockId(of ev: EKEvent) -> String? {
        guard let s = ev.url?.absoluteString, s.hasPrefix(Self.marker) else { return nil }
        return String(s.dropFirst(Self.marker.count))
    }

    private func existingPlanfectCalendar() -> EKCalendar? {
        store.calendars(for: .event).first { $0.title == Self.calendarTitle }
    }

    /// Find or create our dedicated, writable "Planfect" calendar.
    private func planfectCalendar() -> EKCalendar? {
        if let c = store.calendars(for: .event).first(where: { $0.title == Self.calendarTitle && $0.allowsContentModifications }) {
            return c
        }
        let cal = EKCalendar(for: .event, eventStore: store)
        cal.title = Self.calendarTitle
        cal.cgColor = CGColor(srgbRed: 110 / 255, green: 84 / 255, blue: 240 / 255, alpha: 1)   // brand violet
        let source = store.defaultCalendarForNewEvents?.source
            ?? store.sources.first(where: { $0.sourceType == .calDAV })
            ?? store.sources.first(where: { $0.sourceType == .local })
            ?? store.sources.first
        guard let src = source else { return nil }
        cal.source = src
        do { try store.saveCalendar(cal, commit: true); return cal } catch { return nil }
    }
}

struct CalendarBusy: Encodable {
    let start: String   // ISO-8601
    let end: String
    let title: String
}
