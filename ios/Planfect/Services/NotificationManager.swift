import Foundation
import UIKit
import UserNotifications

/// Schedules local notifications for upcoming blocks: a "time to head out" nudge at the start of
/// each commute, and an "up next / focus time" reminder a few minutes before each task block.
///
/// Re-synced whenever the schedule is (re)loaded or a new plan is made: it clears all pending
/// requests and re-adds the soonest ones, so a done/deleted/rescheduled block never leaves a
/// stale buzz behind. Local-only — needs no push entitlement or Apple Developer account.
@MainActor
final class NotificationManager: NSObject, UNUserNotificationCenterDelegate {
    static let shared = NotificationManager()
    private override init() {
        super.init()
        center.delegate = self
        registerCategories()
    }

    private static let taskCategory = "PLANFECT_TASK"       // Mark done + Snooze
    private static let commuteCategory = "PLANFECT_COMMUTE" // Snooze only

    private func registerCategories() {
        let done = UNNotificationAction(identifier: "DONE", title: NSLocalizedString("Mark done", comment: ""), options: [])
        let snooze = UNNotificationAction(identifier: "SNOOZE", title: NSLocalizedString("Snooze 10 min", comment: ""), options: [])
        center.setNotificationCategories([
            UNNotificationCategory(identifier: Self.taskCategory, actions: [done, snooze], intentIdentifiers: [], options: []),
            UNNotificationCategory(identifier: Self.commuteCategory, actions: [snooze], intentIdentifiers: [], options: []),
        ])
    }

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
    private var lastSignature = ""  // skip the (60+ syscall) reschedule when nothing changed

    /// Ask for permission if the user hasn't decided yet and reminders are on. Safe to call often.
    func ensureAuthorization() async {
        guard enabled else { return }
        #if DEBUG
        // Screenshot/automation runs: skip the OS permission prompt so it never covers the UI.
        if ProcessInfo.processInfo.environment["PLANFECT_NO_NOTIF_PROMPT"] == "1" { return }
        #endif
        let settings = await center.notificationSettings()
        if settings.authorizationStatus == .notDetermined {
            _ = try? await center.requestAuthorization(options: [.alert, .sound, .badge])
        }
        // Register for remote (APNs) push so the backend can deliver friend + collaborative-plan
        // alerts. Safe to call repeatedly; the device token arrives in AppDelegate.
        let status = await center.notificationSettings().authorizationStatus
        if status == .authorized || status == .provisional {
            UIApplication.shared.registerForRemoteNotifications()
        }
    }

    /// Clear all pending reminders and re-schedule from the current blocks. Idempotent.
    /// Cheap no-op when the relevant inputs are unchanged (e.g. just switching back to the tab).
    func reschedule(for blocks: [TimeBlock]) async {
        WidgetBridge.publish(blocks)   // keep the home/lock-screen widget in sync with every load

        let sig = "\(enabled)|\(leadMinutes)|" + blocks.lazy
            .filter { !$0.isDone }
            .map { "\($0.id.uuidString):\(Int($0.start.timeIntervalSince1970))" }
            .joined(separator: ",")
        if sig == lastSignature { return }
        lastSignature = sig

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
    func cancelAll() { center.removeAllPendingNotificationRequests(); lastSignature = "" }

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
            content.title = NSLocalizedString("🚗 Time to head out", comment: "")
            content.body = b.title.isEmpty ? NSLocalizedString("Your commute starts now.", comment: "") : b.title
            content.categoryIdentifier = Self.commuteCategory

        case "task":
            guard b.start > now else { return nil }
            fire = max(b.start.addingTimeInterval(-lead), now.addingTimeInterval(5))  // never in the past
            // Deep-work-ish categories get a "time to focus" framing; everything else "up next".
            let key = TaskCategory.key(b)
            let focusStyle = ["work", "focus", "learning"].contains(key)
            content.title = focusStyle
                ? String(format: NSLocalizedString("🎯 %@ time", comment: ""), NSLocalizedString(TaskCategory.of(b).label, comment: ""))
                : NSLocalizedString("⏰ Up next", comment: "")
            content.body = "\(b.title) · \(b.start.formatted(date: .omitted, time: .shortened))"
            content.categoryIdentifier = Self.taskCategory

        default:
            return nil   // routine / buffer blocks don't nudge
        }

        let comps = Calendar.current.dateComponents([.year, .month, .day, .hour, .minute, .second], from: fire)
        let trigger = UNCalendarNotificationTrigger(dateMatching: comps, repeats: false)
        let req = UNNotificationRequest(identifier: "blk-\(b.id.uuidString)", content: content, trigger: trigger)
        return (fire, req)
    }

    // MARK: - Action handling (Mark done / Snooze straight from the notification)

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter,
                                            willPresent notification: UNNotification) async
    -> UNNotificationPresentationOptions { [.banner, .sound] }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter,
                                            didReceive response: UNNotificationResponse) async {
        let id = response.notification.request.identifier
        let action = response.actionIdentifier
        let content = response.notification.request.content
        await handle(action: action, id: id, content: content)
    }

    private func handle(action: String, id: String, content: UNNotificationContent) async {
        guard id.hasPrefix("blk-") else { return }
        switch action {
        case "DONE":
            if let uuid = UUID(uuidString: String(id.dropFirst(4).prefix(36))) {
                try? await SupabaseManager.shared.setBlockDone(uuid, true)
                if let blocks = try? await SupabaseManager.shared.fetchBlocks() { await reschedule(for: blocks) }
            }
        case "SNOOZE":
            let copy = (content.mutableCopy() as? UNMutableNotificationContent) ?? UNMutableNotificationContent()
            let trigger = UNTimeIntervalNotificationTrigger(timeInterval: 600, repeats: false)   // +10 min
            try? await center.add(UNNotificationRequest(identifier: id + "-snooze", content: copy, trigger: trigger))
        default:
            break   // default tap → just opens the app
        }
    }
}
