import SwiftUI

/// Top-level router: loading → auth → onboarding → main.
struct RootView: View {
    @EnvironmentObject var supa: SupabaseManager

    var body: some View {
        Group {
            if supa.bootstrapping {
                ProgressView("Loading…")
            } else if supa.session == nil {
                AuthView()
            } else if supa.needsOnboarding == nil {
                ProgressView("Setting up…")
            } else if supa.needsOnboarding == true {
                OnboardingView()
            } else {
                MainTabView()
            }
        }
        .animation(.default, value: supa.session?.user.id)
        .animation(.default, value: supa.needsOnboarding)
        .animation(.default, value: supa.bootstrapping)
    }
}
