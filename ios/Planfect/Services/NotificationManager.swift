import Foundation
import UserNotifications

/// Schedules local notifications for upcoming blocks: a "time to head out" nudge at the start of
/// each commute, and an "up next / focus time" reminder a few minutes before each task block.
///
/// Re-synced whenever the schedule is (re)loaded or a new plan is made: it clears all pending
/// requests and re-adds the soonest ones, so a done/deleted/rescheduled block never leaves a
/// stale buzz behind. Local-only — needs no push entitlement or Apple Developer account.
@MainActor
final class NotificationManager {
    static let shared = NotificationManager()
    private init() {}

    // Settings live in UserDefaults so Profile (@AppStorage) and this manager share one source.
    static let enabledKey = "planfect.remindersEnabled"
    static let leadKey = "planfect.reminderLeadMin"

    private var enabled: Bool {
        let d = UserDefaults.standard
        return d.object(forKey: Self.enabledKey) == nil ? true : d.bool(forKey: Self.enabledKey)
    }
    private var leadMinutes: Int {
        let d = UserDefaults.standard
        return d.object(forKey: Self.leadKey) == nil ? 10 : d.integer(forKey: Self.leadKey)
    }

    private let center = UNUserNotificationCenter.current()
    private let maxScheduled = 60   // iOS caps pending requests at 64

    /// Ask for permission if the user hasn't decided yet and reminders are on. Safe to call often.
    func ensureAuthorization() async {
        guard enabled else { return }
        let settings = await center.notificationSettings()
        if settings.authorizationStatus == .notDetermined {
            _ = try? await center.requestAuthorization(options: [.alert, .sound, .badge])
        }
    }

    /// Clear all pending reminders and re-schedule from the current blocks. Idempotent.
    func reschedule(for blocks: [TimeBlock]) async {
        center.removeAllPendingNotificationRequests()
        guard enabled else { return }

        let now = Date()
        let lead = TimeInterval(leadMinutes * 60)

        // Future blocks only, soonest first, capped to the OS limit.
        let planned = blocks
            .filter { !$0.isDone }
            .compactMap { request(for: $0, now: now, lead: lead) }
            .sorted { $0.fire < $1.fire }
            .prefix(maxScheduled)

        #if DEBUG
        logBuilt(Array(planned))
        #endif

        await ensureAuthorization()
        let status = await center.notificationSettings().authorizationStatus
        guard status == .authorized || status == .provisional else { return }

        for item in planned { try? await center.add(item.request) }
    }

    #if DEBUG
    private func logBuilt(_ planned: [(fire: Date, request: UNNotificationRequest)]) {
        guard ProcessInfo.processInfo.environment["PLANFECT_LOG_REMINDERS"] == "1" else { return }
        print("🔔[Planfect] built \(planned.count) reminder(s)")
        for p in planned {
            print("  • \(p.fire) — \(p.request.content.title) :: \(p.request.content.body)")
        }
    }
    #endif

    /// Drop everything (used when the user turns reminders off).
    func cancelAll() { center.removeAllPendingNotificationRequests() }

    // MARK: - One block → one reminder

    private func request(for b: TimeBlock, now: Date, lead: TimeInterval) -> (fire: Date, request: UNNotificationRequest)? {
        let content = UNMutableNotificationContent()
        content.sound = .default
        let fire: Date

        switch b.kind {
        case "commute":
            // The commute block's start IS the moment to leave.
            guard b.start > now else { return nil }
            fire = b.start
            content.title = "🚗 Time to head out"
            content.body = b.title.isEmpty ? "Your commute starts now." : b.title

        case "task":
            guard b.start > now else { return nil }
            fire = max(b.start.addingTimeInterval(-lead), now.addingTimeInterval(5))  // never in the past
            // Deep-work-ish categories get a "time to focus" framing; everything else "up next".
            let key = TaskCategory.key(b)
            let focusStyle = ["work", "focus", "learning"].contains(key)
            content.title = focusStyle ? "🎯 \(TaskCategory.of(b).label) time" : "⏰ Up next"
            content.body = "\(b.title) · \(b.start.formatted(date: .omitted, time: .shortened))"

        default:
            return nil   // routine / buffer blocks don't nudge
        }

        let comps = Calendar.current.dateComponents([.year, .month, .day, .hour, .minute, .second], from: fire)
        let trigger = UNCalendarNotificationTrigger(dateMatching: comps, repeats: false)
        let req = UNNotificationRequest(identifier: "blk-\(b.id.uuidString)", content: content, trigger: trigger)
        return (fire, req)
    }
}
