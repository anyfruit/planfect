import SwiftUI

/// Lightweight cross-screen navigation: which tab is showing, and a request to jump the
/// Schedule to a specific day (used when tapping a chat receipt).
@MainActor
final class AppRouter: ObservableObject {
    @Published var tab = 0            // 0 = Chat, 1 = Schedule
    @Published var jumpDay: Date?     // when set, Schedule shows this day (Day view)

    func openSchedule(on day: Date) {
        jumpDay = day
        tab = 1
    }
}
