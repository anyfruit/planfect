import SwiftUI
import UIKit

@main
struct PlanfectApp: App {
    @StateObject private var supa = SupabaseManager.shared
    @StateObject private var router = AppRouter()

    init() {
        // Rounded nav-bar titles to match the in-content SF Rounded typeface.
        func rounded(_ size: CGFloat, _ weight: UIFont.Weight) -> UIFont {
            let base = UIFont.systemFont(ofSize: size, weight: weight)
            return base.fontDescriptor.withDesign(.rounded).map { UIFont(descriptor: $0, size: size) } ?? base
        }
        let appearance = UINavigationBarAppearance()
        appearance.configureWithDefaultBackground()
        appearance.titleTextAttributes = [.font: rounded(17, .semibold)]
        appearance.largeTitleTextAttributes = [.font: rounded(34, .bold)]
        UINavigationBar.appearance().standardAppearance = appearance
        UINavigationBar.appearance().scrollEdgeAppearance = appearance
        UINavigationBar.appearance().compactAppearance = appearance
    }

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(supa)
                .environmentObject(router)
                .task { await supa.start() }
        }
    }
}
