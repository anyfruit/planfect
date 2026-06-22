import Foundation

// Friend management + profile editing + avatar upload. Friend actions go through the `friends`
// Edge Function (one POST with an `action`); profile fields go through PostgREST; the avatar is a
// direct upload to the `avatars` Storage bucket. All carry the user's JWT, so RLS / the function's
// own uid check scope everything to the caller.
extension SupabaseManager {

    /// POST one action to the `friends` function and return the raw body (throws a readable error).
    @discardableResult
    private func friendsCall(_ body: [String: String]) async throws -> Data {
        let token = await currentToken()
        var req = URLRequest(url: URL(string: SupabaseConfig.url.absoluteString + "/functions/v1/friends")!)
        req.httpMethod = "POST"
        req.setValue(SupabaseConfig.anonKey, forHTTPHeaderField: "apikey")
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try JSONSerialization.data(withJSONObject: body)
        let (data, resp) = try await URLSession.shared.data(for: req)
        if let http = resp as? HTTPURLResponse, !(200..<300).contains(http.statusCode) {
            let msg = (try? JSONDecoder().decode([String: String].self, from: data))?["error"] ?? "HTTP \(http.statusCode)"
            throw NSError(domain: "Planfect.Friends", code: http.statusCode,
                          userInfo: [NSLocalizedDescriptionKey: msg])
        }
        return data
    }

    // MARK: Friends

    func friendsList() async throws -> FriendsList {
        let data = try await friendsCall(["action": "list"])
        return try JSONDecoder().decode(FriendsList.self, from: data)
    }

    func searchUsers(_ q: String) async throws -> [FriendProfile] {
        let trimmed = q.trimmingCharacters(in: .whitespaces)
        guard trimmed.count >= 2 else { return [] }
        let data = try await friendsCall(["action": "search", "q": trimmed])
        struct R: Decodable { let results: [FriendProfile] }
        return (try JSONDecoder().decode(R.self, from: data)).results
    }

    func sendFriendRequest(_ targetId: UUID) async throws {
        try await friendsCall(["action": "request", "target_id": targetId.uuidString])
    }

    func acceptFriend(_ requesterId: UUID) async throws {
        try await friendsCall(["action": "accept", "requester_id": requesterId.uuidString])
    }

    func declineFriend(_ otherId: UUID) async throws {
        try await friendsCall(["action": "decline", "requester_id": otherId.uuidString])
    }

    func removeFriend(_ friendId: UUID) async throws {
        try await friendsCall(["action": "remove", "friend_id": friendId.uuidString])
    }

    func setFriendTier(_ friendId: UUID, close: Bool) async throws {
        try await friendsCall(["action": "set_tier", "friend_id": friendId.uuidString,
                               "tier": close ? "close" : "friend"])
    }

    // MARK: Profile

    func fetchMyProfile() async throws -> MyProfile {
        guard let uid = userId?.uuidString else { throw profileError("Not signed in") }
        let data = try await rest("GET", "profiles?select=username,display_name,avatar_url&id=eq.\(uid)")
        guard let p = try JSONDecoder().decode([MyProfile].self, from: data).first else {
            throw profileError("Profile not found")
        }
        return p
    }

    /// Set the unique @username. Surfaces a friendly message when it's already taken (PostgREST 409).
    func updateUsername(_ username: String) async throws {
        guard let uid = userId?.uuidString else { return }
        do {
            _ = try await rest("PATCH", "profiles?id=eq.\(uid)",
                               body: try JSONEncoder().encode(["username": username]), prefer: "return=minimal")
        } catch let e as NSError where e.code == 409 {
            throw profileError("That username is already taken.")
        }
    }

    func updateDisplayName(_ name: String) async throws {
        guard let uid = userId?.uuidString else { return }
        _ = try await rest("PATCH", "profiles?id=eq.\(uid)",
                           body: try JSONEncoder().encode(["display_name": name]), prefer: "return=minimal")
    }

    /// Upload JPEG bytes to `avatars/<uid>/avatar.jpg`, point the profile at the public URL
    /// (cache-busted so the new image shows), and return that URL.
    func uploadAvatar(_ jpeg: Data) async throws -> String {
        guard let uid = userId?.uuidString else { throw profileError("Not signed in") }
        let token = await currentToken()
        let path = "\(uid)/avatar.jpg"
        var req = URLRequest(url: URL(string: SupabaseConfig.url.absoluteString + "/storage/v1/object/avatars/\(path)")!)
        req.httpMethod = "POST"
        req.setValue(SupabaseConfig.anonKey, forHTTPHeaderField: "apikey")
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        req.setValue("image/jpeg", forHTTPHeaderField: "Content-Type")
        req.setValue("true", forHTTPHeaderField: "x-upsert")
        req.httpBody = jpeg
        let (data, resp) = try await URLSession.shared.data(for: req)
        if let http = resp as? HTTPURLResponse, !(200..<300).contains(http.statusCode) {
            let msg = String(data: data, encoding: .utf8) ?? "upload failed"
            throw NSError(domain: "Planfect.Avatar", code: http.statusCode, userInfo: [NSLocalizedDescriptionKey: msg])
        }
        let publicURL = SupabaseConfig.url.absoluteString
            + "/storage/v1/object/public/avatars/\(path)?t=\(Int(Date().timeIntervalSince1970))"
        _ = try await rest("PATCH", "profiles?id=eq.\(uid)",
                           body: try JSONEncoder().encode(["avatar_url": publicURL]), prefer: "return=minimal")
        return publicURL
    }

    private func profileError(_ msg: String) -> NSError {
        NSError(domain: "Planfect.Profile", code: 0, userInfo: [NSLocalizedDescriptionKey: msg])
    }
}
