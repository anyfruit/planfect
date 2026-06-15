import SwiftUI

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
        }
        .sheet(isPresented: $showProfile) { ProfileView() }
        .onAppear {
            Task { await NotificationManager.shared.ensureAuthorization() }
            #if DEBUG
            if ProcessInfo.processInfo.environment["PLANFECT_START_TAB"] == "schedule" { router.tab = 1 }
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
