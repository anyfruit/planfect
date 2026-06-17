import SwiftUI

struct AuthView: View {
    @EnvironmentObject var supa: SupabaseManager
    @State private var email = ""
    @State private var password = ""
    @State private var isSignUp = false
    @State private var error: String?
    @State private var loading = false

    private var brand: LinearGradient {
        LinearGradient(colors: [.accentColor, .purple], startPoint: .topLeading, endPoint: .bottomTrailing)
    }
    private var canSubmit: Bool { !loading && !email.isEmpty && password.count >= 6 }

    var body: some View {
        VStack(spacing: 24) {
            Spacer()
            VStack(spacing: 14) {
                Image(systemName: "sparkles")
                    .font(.system(size: 34, weight: .bold)).foregroundStyle(.white)
                    .frame(width: 84, height: 84)
                    .background(brand, in: RoundedRectangle(cornerRadius: 22, style: .continuous))
                    .shadow(color: .accentColor.opacity(0.3), radius: 16, y: 8)
                Text("Planfect")
                    .font(.system(size: 34, weight: .heavy, design: .rounded))
                    .foregroundStyle(brand)
                Text("Tell it your plans. It builds your day.")
                    .font(.system(.subheadline, design: .rounded)).foregroundStyle(.secondary)
            }
            .padding(.bottom, 6)

            Picker("", selection: $isSignUp.animation()) {
                Text("Sign in").tag(false)
                Text("Create account").tag(true)
            }
            .pickerStyle(.segmented)

            VStack(spacing: 12) {
                field {
                    TextField("Email", text: $email)
                        .textContentType(.emailAddress).keyboardType(.emailAddress)
                        .textInputAutocapitalization(.never).autocorrectionDisabled()
                }
                field {
                    SecureField("Password", text: $password)
                        .textContentType(isSignUp ? .newPassword : .password)
                }
            }

            if let error {
                Text(error).font(.footnote).foregroundStyle(.red)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }

            Button(action: submit) {
                Group {
                    if loading { ProgressView().tint(.white) }
                    else { Text(isSignUp ? "Create account" : "Sign in").bold() }
                }
                .frame(maxWidth: .infinity).frame(height: 26)
            }
            .foregroundStyle(.white).padding(.vertical, 6)
            .background(canSubmit ? AnyShapeStyle(brand) : AnyShapeStyle(Color(.systemGray4)), in: Capsule())
            .disabled(!canSubmit)
            .animation(.easeInOut(duration: 0.15), value: canSubmit)

            HStack(spacing: 10) {
                Rectangle().fill(Color(.systemGray4)).frame(height: 1)
                Text("or").font(.footnote).foregroundStyle(.secondary)
                Rectangle().fill(Color(.systemGray4)).frame(height: 1)
            }

            AppleSignInButton { msg in error = msg }

            Spacer(); Spacer()
        }
        .padding(28)
        .fontDesign(.rounded)
    }

    private func field<V: View>(@ViewBuilder _ content: () -> V) -> some View {
        content()
            .padding(.horizontal, 14).padding(.vertical, 13)
            .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 12))
    }

    private func submit() {
        loading = true
        error = nil
        Task {
            do {
                if isSignUp {
                    try await supa.signUp(email: email, password: password)
                } else {
                    try await supa.signIn(email: email, password: password)
                }
            } catch {
                self.error = error.localizedDescription
            }
            loading = false
        }
    }
}
