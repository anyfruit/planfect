import SwiftUI

/// Everything we have to ASK the user, asked on the FIRST open instead of lazily.
///
/// Before this, AI consent only appeared when they hit send the first time (so their first message
/// stalled behind a legal sheet), and Apple Calendar sync was buried in Profile where nobody found
/// it. Order matters: consent first — App Store 5.1.1(i) requires it before anything is sent —
/// then notifications, then calendar sync.
@MainActor
final class FirstRunCoordinator: ObservableObject {
    enum Step: Int, Identifiable { case aiConsent, calendar; var id: Int { rawValue } }

    @Published var step: Step?
    private static let doneKey = "planfect.firstRun.v2"
    private var running = false

    /// Idempotent: safe to call on every appearance of the main tabs.
    func startIfNeeded() async {
        guard !running else { return }
        running = true
        guard !UserDefaults.standard.bool(forKey: Self.doneKey) else {
            await NotificationManager.shared.ensureAuthorization()   // no-op once iOS has an answer
            return
        }
        if ChatViewModel.hasStoredAIConsent {
            await askRemaining()
        } else {
            step = .aiConsent
        }
    }

    func grantConsent() {
        ChatViewModel.storeAIConsent()
        step = nil
        Task { await askRemaining() }
    }

    /// Declining is not a dead end: the send-time gate in ChatViewModel still asks before anything
    /// leaves the device, so don't re-open this sheet on every launch.
    func declineConsent() {
        step = nil
        Task { await askRemaining() }
    }

    private func askRemaining() async {
        await NotificationManager.shared.ensureAuthorization()
        if CalendarManager.shared.enabled { finish() } else { step = .calendar }
    }

    func enableCalendar() async {
        // Flip the flag first so CalendarManager.enabled is true when it checks for access.
        UserDefaults.standard.set(true, forKey: CalendarManager.syncKey)
        if await CalendarManager.shared.ensureAccess() == false {
            UserDefaults.standard.set(false, forKey: CalendarManager.syncKey)   // denied → leave it off
        }
        finish()
    }

    func skipCalendar() { finish() }

    private func finish() {
        UserDefaults.standard.set(true, forKey: Self.doneKey)
        step = nil
    }
}

/// The Apple Calendar ask. Plain opt-in: what it does, what it won't touch.
struct CalendarSyncAskView: View {
    var onEnable: () -> Void
    var onSkip: () -> Void

    var body: some View {
        VStack(spacing: 0) {
            ScrollView {
                VStack(alignment: .leading, spacing: 22) {
                    VStack(alignment: .leading, spacing: 12) {
                        Image(systemName: "calendar.badge.clock")
                            .font(.system(size: 30, weight: .bold))
                            .foregroundStyle(LinearGradient(colors: [.accentColor, .purple],
                                                            startPoint: .topLeading, endPoint: .bottomTrailing))
                        Text(String(localized: "Sync with Apple Calendar?"))
                            .font(.system(.title2, design: .rounded).weight(.bold))
                        Text(String(localized: "Planfect can read your existing events so it never books over them, and write the plans it makes into their own Planfect calendar."))
                            .font(.callout).foregroundStyle(.secondary)
                    }
                    VStack(alignment: .leading, spacing: 18) {
                        row("eye.fill", String(localized: "Plans around what's already there"),
                            String(localized: "Your real events are treated as busy, so nothing lands on top of them."))
                        row("square.and.pencil", String(localized: "Only touches its own events"),
                            String(localized: "Plans are written to a separate \"Planfect\" calendar. Your other events are never edited or deleted."))
                        row("slider.horizontal.3", String(localized: "Off anytime"),
                            String(localized: "You can turn this off later under Profile."))
                    }
                }
                .padding(24)
            }
            VStack(spacing: 10) {
                Button(action: onEnable) {
                    Text(String(localized: "Turn on sync")).font(.headline)
                        .frame(maxWidth: .infinity).padding(.vertical, 4)
                }
                .buttonStyle(.borderedProminent).controlSize(.large)
                Button(action: onSkip) {
                    Text(String(localized: "Not now")).font(.subheadline.weight(.medium))
                        .foregroundStyle(.secondary)
                }
            }
            .padding(.horizontal, 24).padding(.top, 12).padding(.bottom, 20)
            .background(.bar)
        }
        .presentationDragIndicator(.hidden)
    }

    private func row(_ icon: String, _ title: String, _ detail: String) -> some View {
        HStack(alignment: .top, spacing: 14) {
            Image(systemName: icon)
                .font(.system(size: 17, weight: .semibold))
                .foregroundStyle(Color.accentColor)
                .frame(width: 26, height: 26)
            VStack(alignment: .leading, spacing: 3) {
                Text(title).font(.system(.subheadline, design: .rounded).weight(.semibold))
                Text(detail).font(.footnote).foregroundStyle(.secondary)
            }
        }
    }
}
