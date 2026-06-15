import SwiftUI

@main
struct PlanfectApp: App {
    @StateObject private var supa = SupabaseManager.shared
    @StateObject private var router = AppRouter()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(supa)
                .environmentObject(router)
                .task { await supa.start() }
        }
    }
}
