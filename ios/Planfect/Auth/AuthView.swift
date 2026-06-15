import SwiftUI

struct AuthView: View {
    @EnvironmentObject var supa: SupabaseManager
    @State private var email = "test@planfect.dev"
    @State private var password = ""
    @State private var isSignUp = false
    @State private var error: String?
    @State private var loading = false

    var body: some View {
        VStack(spacing: 22) {
            Spacer()
            VStack(spacing: 8) {
                Image(systemName: "calendar.badge.clock")
                    .font(.system(size: 52)).foregroundStyle(.tint)
                Text("Planfect").font(.largeTitle.bold())
                Text("Tell it your plans. It builds your day.")
                    .font(.subheadline).foregroundStyle(.secondary)
            }

            Picker("", selection: $isSignUp) {
                Text("Sign in").tag(false)
                Text("Create account").tag(true)
            }
            .pickerStyle(.segmented)

            VStack(spacing: 12) {
                TextField("Email", text: $email)
                    .textContentType(.emailAddress)
                    .keyboardType(.emailAddress)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                SecureField("Password", text: $password)
                    .textContentType(isSignUp ? .newPassword : .password)
            }
            .textFieldStyle(.roundedBorder)

            if let error {
                Text(error).font(.footnote).foregroundStyle(.red)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }

            Button(action: submit) {
                Group {
                    if loading { ProgressView() }
                    else { Text(isSignUp ? "Create account" : "Sign in").bold() }
                }
                .frame(maxWidth: .infinity).frame(height: 24)
            }
            .buttonStyle(.borderedProminent)
            .disabled(loading || email.isEmpty || password.count < 6)

            Spacer()
        }
        .padding(28)
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
