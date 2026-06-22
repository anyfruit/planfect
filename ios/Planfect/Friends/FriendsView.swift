import SwiftUI

/// The Friends tab — incoming requests to accept, your friends (tap for tier + removal), and
/// the requests you've sent. Add people by @username via the toolbar.
struct FriendsView: View {
    @EnvironmentObject var supa: SupabaseManager
    @State private var data = FriendsList(friends: [], incoming: [], outgoing: [])
    @State private var loading = false
    @State private var error: String?
    @State private var showAdd = false

    var body: some View {
        List {
            if !data.incoming.isEmpty {
                Section("Requests") {
                    ForEach(data.incoming) { f in
                        FriendRow(friend: f) {
                            HStack(spacing: 8) {
                                Button { act { try await supa.acceptFriend(f.id) } } label: {
                                    Text("Accept").font(.subheadline.weight(.semibold))
                                }
                                .buttonStyle(.borderedProminent).controlSize(.small)
                                Button { act { try await supa.declineFriend(f.id) } } label: {
                                    Image(systemName: "xmark")
                                }
                                .buttonStyle(.bordered).controlSize(.small)
                            }
                        }
                    }
                }
            }

            Section(header: Text(data.friends.isEmpty ? "" : "Friends")) {
                if data.friends.isEmpty && data.incoming.isEmpty && data.outgoing.isEmpty {
                    emptyState
                } else {
                    ForEach(data.friends) { f in
                        NavigationLink {
                            FriendDetailView(friend: f) { Task { await load() } }
                        } label: {
                            FriendRow(friend: f) {
                                if f.isClose { closeBadge }
                            }
                        }
                    }
                }
            }

            if !data.outgoing.isEmpty {
                Section("Sent") {
                    ForEach(data.outgoing) { f in
                        FriendRow(friend: f) {
                            Button("Cancel") { act { try await supa.declineFriend(f.id) } }
                                .font(.caption).buttonStyle(.bordered).controlSize(.small)
                        }
                    }
                }
            }
        }
        .navigationTitle("Friends")
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button { showAdd = true } label: { Image(systemName: "person.badge.plus") }
                    .accessibilityLabel(Text("Add friend"))
            }
        }
        .sheet(isPresented: $showAdd, onDismiss: { Task { await load() } }) { AddFriendView() }
        .refreshable { await load() }
        .task { await load() }
        .overlay {
            if loading && data.friends.isEmpty && data.incoming.isEmpty { ProgressView() }
        }
        .alert("Friends", isPresented: Binding(get: { error != nil }, set: { if !$0 { error = nil } })) {
            Button("OK", role: .cancel) {}
        } message: { Text(error ?? "") }
    }

    private var closeBadge: some View {
        Text("Close").font(.caption2.weight(.bold))
            .padding(.horizontal, 7).padding(.vertical, 3)
            .background(Color.accentColor.opacity(0.15), in: Capsule())
            .foregroundStyle(.tint)
    }

    private var emptyState: some View {
        VStack(spacing: 8) {
            Image(systemName: "person.2").font(.largeTitle).foregroundStyle(.tint)
            Text("No friends yet").font(.headline)
            Text("Add friends by their @username to share schedules.")
                .font(.subheadline).foregroundStyle(.secondary).multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity).padding(.vertical, 24)
    }

    private func load() async {
        loading = true; defer { loading = false }
        do { data = try await supa.friendsList() }
        catch { self.error = error.localizedDescription }
    }

    private func act(_ work: @escaping () async throws -> Void) {
        Task {
            do { try await work(); await load() }
            catch { self.error = error.localizedDescription }
        }
    }
}

/// One person row: avatar, name + @handle, and a caller-supplied trailing control.
struct FriendRow<Trailing: View>: View {
    let friend: FriendProfile
    @ViewBuilder var trailing: () -> Trailing

    var body: some View {
        HStack(spacing: 12) {
            Avatar(url: friend.avatarURL, size: 42)
            VStack(alignment: .leading, spacing: 2) {
                Text(friend.name).font(.subheadline.weight(.medium))
                if !friend.handle.isEmpty {
                    Text(friend.handle).font(.caption).foregroundStyle(.secondary)
                }
            }
            Spacer()
            trailing()
        }
        .padding(.vertical, 2)
    }
}

/// Circular avatar that loads `avatar_url`, falling back to a person glyph.
struct Avatar: View {
    let url: URL?
    var size: CGFloat = 42
    var body: some View {
        AsyncImage(url: url) { img in
            img.resizable().scaledToFill()
        } placeholder: {
            Image(systemName: "person.crop.circle.fill").resizable().scaledToFit()
                .foregroundStyle(.quaternary)
        }
        .frame(width: size, height: size)
        .clipShape(Circle())
    }
}

/// A friend's detail: set their tier (regular vs close) or remove them.
private struct FriendDetailView: View {
    let friend: FriendProfile
    let onChange: () -> Void
    @EnvironmentObject var supa: SupabaseManager
    @Environment(\.dismiss) private var dismiss
    @State private var close: Bool
    @State private var working = false
    @State private var error: String?

    init(friend: FriendProfile, onChange: @escaping () -> Void) {
        self.friend = friend
        self.onChange = onChange
        _close = State(initialValue: friend.isClose)
    }

    var body: some View {
        List {
            Section {
                HStack(spacing: 14) {
                    Avatar(url: friend.avatarURL, size: 64)
                    VStack(alignment: .leading, spacing: 3) {
                        Text(friend.name).font(.title3.weight(.semibold))
                        if !friend.handle.isEmpty { Text(friend.handle).foregroundStyle(.secondary) }
                    }
                }
                .padding(.vertical, 4)
            }
            Section {
                Toggle("Close friend", isOn: Binding(
                    get: { close },
                    set: { close = $0; setTier($0) }
                ))
            } footer: {
                Text("Close friends can see your specific plans and schedule things with you. Regular friends only see when you're busy.")
            }
            Section {
                Button("Remove friend", role: .destructive) { remove() }
            }
        }
        .navigationTitle(friend.name).navigationBarTitleDisplayMode(.inline)
        .disabled(working)
        .alert("Friends", isPresented: Binding(get: { error != nil }, set: { if !$0 { error = nil } })) {
            Button("OK", role: .cancel) {}
        } message: { Text(error ?? "") }
    }

    private func setTier(_ isClose: Bool) {
        working = true
        Task {
            defer { working = false }
            do { try await supa.setFriendTier(friend.id, close: isClose); onChange() }
            catch { self.error = error.localizedDescription; close = !isClose }   // revert on failure
        }
    }

    private func remove() {
        working = true
        Task {
            defer { working = false }
            do { try await supa.removeFriend(friend.id); onChange(); dismiss() }
            catch { self.error = error.localizedDescription }
        }
    }
}

/// Search users by @username and send (or accept) friend requests.
private struct AddFriendView: View {
    @EnvironmentObject var supa: SupabaseManager
    @Environment(\.dismiss) private var dismiss
    @State private var query = ""
    @State private var results: [FriendProfile] = []
    @State private var searching = false
    @State private var error: String?
    @State private var actedOn: Set<UUID> = []

    var body: some View {
        NavigationStack {
            List {
                ForEach(results) { u in
                    HStack(spacing: 12) {
                        Avatar(url: u.avatarURL, size: 42)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(u.name).font(.subheadline.weight(.medium))
                            if !u.handle.isEmpty { Text(u.handle).font(.caption).foregroundStyle(.secondary) }
                        }
                        Spacer()
                        actionButton(u)
                    }
                }
                if !searching && results.isEmpty && query.trimmingCharacters(in: .whitespaces).count >= 2 {
                    Text("No users found").foregroundStyle(.secondary)
                }
            }
            .searchable(text: $query, prompt: "Search by @username")
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()
            .navigationTitle("Add friend").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .topBarTrailing) { Button("Done") { dismiss() } } }
            .task(id: query) { await runSearch() }
            .alert("Add friend", isPresented: Binding(get: { error != nil }, set: { if !$0 { error = nil } })) {
                Button("OK", role: .cancel) {}
            } message: { Text(error ?? "") }
        }
    }

    @ViewBuilder private func actionButton(_ u: FriendProfile) -> some View {
        let rel = u.relationship ?? "none"
        if rel == "friends" {
            Text("Friends").font(.caption).foregroundStyle(.secondary)
        } else if rel == "requested" || actedOn.contains(u.id) {
            Text("Requested").font(.caption).foregroundStyle(.secondary)
        } else if rel == "incoming" {
            Button("Accept") { act(u) { try await supa.acceptFriend(u.id) } }
                .buttonStyle(.borderedProminent).controlSize(.small)
        } else {
            Button("Add") { act(u) { try await supa.sendFriendRequest(u.id) } }
                .buttonStyle(.borderedProminent).controlSize(.small)
        }
    }

    private func runSearch() async {
        let q = query.trimmingCharacters(in: .whitespaces)
        guard q.count >= 2 else { results = []; return }
        try? await Task.sleep(nanoseconds: 300_000_000)        // debounce; .task(id:) cancels the prior
        guard !Task.isCancelled else { return }
        searching = true; defer { searching = false }
        do { results = try await supa.searchUsers(q) }
        catch { if !Task.isCancelled { self.error = error.localizedDescription } }
    }

    private func act(_ u: FriendProfile, _ work: @escaping () async throws -> Void) {
        Task {
            do { try await work(); actedOn.insert(u.id) }
            catch { self.error = error.localizedDescription }
        }
    }
}
