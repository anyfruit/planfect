import SwiftUI
import UIKit

struct MainTabView: View {
    @EnvironmentObject var router: AppRouter
    @State private var showProfile = false

    var body: some View {
        TabView(selection: $router.tab) {
            NavigationStack {
                ChatView().planfectAvatar { showProfile = true }
            }
            .tabItem { Label("Chat", systemImage: "bubble.left.and.text.bubble.right.fill") }
            .tag(0)

            NavigationStack {
                ScheduleView().planfectAvatar { showProfile = true }
            }
            .tabItem { Label("Schedule", systemImage: "calendar") }
            .tag(1)

            NavigationStack {
                InsightsView().planfectAvatar { showProfile = true }
            }
            .tabItem { Label("Insights", systemImage: "chart.pie.fill") }
            .tag(2)

            NavigationStack {
                FriendsView().planfectAvatar { showProfile = true }
            }
            .tabItem { Label("Friends", systemImage: "person.2.fill") }
            .tag(3)
        }
        .sheet(isPresented: $showProfile) { ProfileView() }
        // Leaving a tab drops the keyboard — otherwise a stuck keyboard can hide the tab bar and
        // trap the user on the current tab.
        .onChange(of: router.tab) { _, _ in UIApplication.shared.endEditing() }
        .onAppear {
            Task { await NotificationManager.shared.ensureAuthorization() }
            #if DEBUG
            if ProcessInfo.processInfo.environment["PLANFECT_START_TAB"] == "schedule" { router.tab = 1 }
            if ProcessInfo.processInfo.environment["PLANFECT_START_TAB"] == "insights" { router.tab = 2 }
            if ProcessInfo.processInfo.environment["PLANFECT_SHOW_PROFILE"] == "1" { showProfile = true }
            #endif
        }
    }
}

extension View {
    /// The top-right avatar button shared across the main tabs.
    func planfectAvatar(_ action: @escaping () -> Void) -> some View {
        toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button(action: action) {
                    Image(systemName: "person.crop.circle").font(.title2)
                }
                .accessibilityLabel("Profile")
            }
        }
    }
}

extension UIApplication {
    /// Resign the first responder app-wide — guarantees the keyboard drops (e.g. when switching tabs)
    /// even if a focused field won't let go on its own.
    func endEditing() {
        sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
    }
}
