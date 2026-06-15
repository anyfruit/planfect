import Foundation
import Supabase

/// Owns the Supabase client and the auth session. Drives top-level routing (auth → onboarding
/// → main) via `session` and `bootstrapping`.
@MainActor
final class SupabaseManager: ObservableObject {
    static let shared = SupabaseManager()

    let client: SupabaseClient
    @Published var session: Session?
    @Published var bootstrapping = true
    @Published var needsOnboarding: Bool?   // nil = unknown/checking

    private init() {
        client = SupabaseClient(supabaseURL: SupabaseConfig.url, supabaseKey: SupabaseConfig.anonKey)
    }

    var userId: UUID? { session?.user.id }
    var email: String? { session?.user.email }

    /// Long-lived: mirrors auth changes (initial restore, sign-in, sign-out, token refresh).
    func start() async {
        // Subscribe FIRST, then trigger auto-login concurrently so the loop catches its event.
        #if DEBUG
        Task { await devAutoLoginIfRequested() }
        #endif
        for await change in client.auth.authStateChanges {
            session = change.session
            bootstrapping = false
            if change.session != nil {
                await refreshOnboardingState()
            } else {
                needsOnboarding = nil
            }
        }
    }

    #if DEBUG
    // Dev convenience for simulator runs: auto-sign-in from launch env vars. Never compiled
    // into release builds, and inert unless the env vars are explicitly set.
    private func devAutoLoginIfRequested() async {
        let env = ProcessInfo.processInfo.environment
        guard session == nil,
              let email = env["PLANFECT_TEST_EMAIL"],
              let password = env["PLANFECT_TEST_PASSWORD"] else { return }
        try? await signIn(email: email, password: password)
    }
    #endif

    func signIn(email: String, password: String) async throws {
        try await client.auth.signIn(email: email, password: password)
    }

    func signUp(email: String, password: String) async throws {
        try await client.auth.signUp(email: email, password: password)
    }

    func signOut() async {
        try? await client.auth.signOut()
    }
}
