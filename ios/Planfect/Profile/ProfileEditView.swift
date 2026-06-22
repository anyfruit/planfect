import SwiftUI
import PhotosUI

/// Edit the user's public profile — avatar, @username (unique, used to find them), and display name.
struct ProfileEditView: View {
    var onSaved: () -> Void = {}
    @EnvironmentObject var supa: SupabaseManager
    @Environment(\.dismiss) private var dismiss

    @State private var username = ""
    @State private var displayName = ""
    @State private var avatarURL: URL?
    @State private var photoItem: PhotosPickerItem?
    @State private var pickedImage: UIImage?
    @State private var saving = false
    @State private var error: String?

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    HStack {
                        Spacer()
                        PhotosPicker(selection: $photoItem, matching: .images) {
                            ZStack(alignment: .bottomTrailing) {
                                avatarPreview
                                Image(systemName: "pencil.circle.fill")
                                    .font(.title2).symbolRenderingMode(.multicolor)
                                    .background(Circle().fill(.background))
                            }
                        }
                        Spacer()
                    }
                    .listRowBackground(Color.clear)
                }

                Section {
                    HStack {
                        Text("@").foregroundStyle(.secondary)
                        TextField("username", text: $username)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                    }
                } header: {
                    Text("Username")
                } footer: {
                    Text("3–20 letters, numbers, or underscore. Friends find and add you by this.")
                }

                Section("Display name") {
                    TextField("Your name", text: $displayName)
                }
            }
            .navigationTitle("Edit profile").navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    if saving { ProgressView() } else { Button("Save") { save() } }
                }
            }
            .task { await loadProfile() }
            .onChange(of: photoItem) { _, item in Task { await loadImage(item) } }
            .alert("Edit profile", isPresented: Binding(get: { error != nil }, set: { if !$0 { error = nil } })) {
                Button("OK", role: .cancel) {}
            } message: { Text(error ?? "") }
        }
    }

    @ViewBuilder private var avatarPreview: some View {
        Group {
            if let img = pickedImage {
                Image(uiImage: img).resizable().scaledToFill()
            } else {
                AsyncImage(url: avatarURL) { img in
                    img.resizable().scaledToFill()
                } placeholder: {
                    Image(systemName: "person.crop.circle.fill").resizable().scaledToFit()
                        .foregroundStyle(.quaternary)
                }
            }
        }
        .frame(width: 96, height: 96)
        .clipShape(Circle())
    }

    private func loadProfile() async {
        guard let p = try? await supa.fetchMyProfile() else { return }
        username = p.username ?? ""
        displayName = p.display_name ?? ""
        avatarURL = p.avatarURL
    }

    private func loadImage(_ item: PhotosPickerItem?) async {
        guard let item, let data = try? await item.loadTransferable(type: Data.self),
              let img = UIImage(data: data) else { return }
        pickedImage = downscaled(img, max: 512)
    }

    private func save() {
        let u = username.trimmingCharacters(in: .whitespaces)
        if !u.isEmpty && u.range(of: "^[A-Za-z0-9_]{3,20}$", options: .regularExpression) == nil {
            error = "Username must be 3–20 letters, numbers, or underscore."
            return
        }
        saving = true
        Task {
            defer { saving = false }
            do {
                if let img = pickedImage, let jpeg = img.jpegData(compressionQuality: 0.82) {
                    _ = try await supa.uploadAvatar(jpeg)
                }
                if !u.isEmpty { try await supa.updateUsername(u) }
                try await supa.updateDisplayName(displayName.trimmingCharacters(in: .whitespaces))
                onSaved()
                dismiss()
            } catch {
                self.error = error.localizedDescription
            }
        }
    }

    /// Shrink so the avatar upload stays small (longest side ≤ `max` points).
    private func downscaled(_ image: UIImage, max: CGFloat) -> UIImage {
        let w = image.size.width, h = image.size.height
        let longest = Swift.max(w, h)
        guard longest > max else { return image }
        let scale = max / longest
        let size = CGSize(width: w * scale, height: h * scale)
        return UIGraphicsImageRenderer(size: size).image { _ in
            image.draw(in: CGRect(origin: .zero, size: size))
        }
    }
}
