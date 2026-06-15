import SwiftUI

@main
struct PlanfectApp: App {
    @StateObject private var supa = SupabaseManager.shared

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(supa)
                .task { await supa.start() }
        }
    }
}
