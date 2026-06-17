import SwiftUI
import AuthenticationServices
import CryptoKit

/// "Sign in with Apple" wired to Supabase. Generates a nonce, sends its SHA-256 to Apple, and
/// exchanges the returned identity token (plus the raw nonce) for a Supabase session.
struct AppleSignInButton: View {
    @EnvironmentObject var supa: SupabaseManager
    var onError: (String) -> Void
    @State private var rawNonce: String?

    var body: some View {
        SignInWithAppleButton(.continue) { request in
            let nonce = Self.randomNonce()
            rawNonce = nonce
            request.requestedScopes = [.fullName, .email]
            request.nonce = Self.sha256(nonce)
        } onCompletion: { result in
            switch result {
            case .success(let auth):
                guard let cred = auth.credential as? ASAuthorizationAppleIDCredential,
                      let tokenData = cred.identityToken,
                      let idToken = String(data: tokenData, encoding: .utf8),
                      let nonce = rawNonce else {
                    onError(NSLocalizedString("Apple sign-in didn't return a token. Try again.", comment: ""))
                    return
                }
                Task {
                    do { try await supa.signInWithApple(idToken: idToken, nonce: nonce) }
                    catch { onError(error.localizedDescription) }
                }
            case .failure(let err):
                // A user-initiated cancel isn't an error worth surfacing.
                if (err as? ASAuthorizationError)?.code != .canceled {
                    onError(err.localizedDescription)
                }
            }
        }
        .signInWithAppleButtonStyle(.black)
        .frame(height: 50)
        .clipShape(Capsule())
    }

    // MARK: - Nonce

    /// Cryptographically-random nonce from an unbiased 64-char alphabet (each byte < 64 maps 1:1).
    static func randomNonce(_ length: Int = 32) -> String {
        let charset = Array("0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz-._")
        var result = ""
        while result.count < length {
            var bytes = [UInt8](repeating: 0, count: 16)
            guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else { continue }
            for b in bytes where result.count < length && Int(b) < charset.count {
                result.append(charset[Int(b)])
            }
        }
        return result
    }

    static func sha256(_ input: String) -> String {
        SHA256.hash(data: Data(input.utf8)).map { String(format: "%02x", $0) }.joined()
    }
}
