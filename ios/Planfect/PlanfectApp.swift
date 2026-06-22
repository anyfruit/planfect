import SwiftUI
import UIKit

@main
struct PlanfectApp: App {
    @StateObject private var supa = SupabaseManager.shared
    @StateObject private var router = AppRouter()
    @StateObject private var lang = LanguageManager.shared
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate

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
            RootHost()
                .environmentObject(supa)
                .environmentObject(router)
                .environmentObject(lang)
                .task {
                    _ = NotificationManager.shared   // sets the notification delegate so actions work at launch
                    await supa.start()
                }
        }
    }
}

/// Wraps RootView so an in-app language change re-renders the whole tree (every localized string
/// picks up the new language live) — via `.id` keyed on the language — WITHOUT re-running the app's
/// one-time startup `.task`, which stays attached to this stable host.
private struct RootHost: View {
    @EnvironmentObject private var lang: LanguageManager
    var body: some View {
        RootView()
            .environment(\.locale, lang.locale)
            .id(lang.lang)
    }
}

/// Receives the APNs device token after registerForRemoteNotifications and uploads it, so the
/// backend can push friend-request / collaborative-plan alerts to this device.
final class AppDelegate: NSObject, UIApplicationDelegate {
    func application(_ application: UIApplication,
                     didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        let token = deviceToken.map { String(format: "%02x", $0) }.joined()
        Task { await SupabaseManager.shared.uploadDeviceToken(token) }
    }
    func application(_ application: UIApplication,
                     didFailToRegisterForRemoteNotificationsWithError error: Error) {
        #if DEBUG
        print("⚠️ remote notification registration failed: \(error.localizedDescription)")
        #endif
    }
}
