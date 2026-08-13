import Foundation

// Friend management + profile editing + avatar upload. Friend actions go through the `friends`
// Edge Function (one POST with an `action`); profile fields go through PostgREST; the avatar is a
// direct upload to the `avatars` Storage bucket. All carry the user's JWT, so RLS / the function's
// own uid check scope everything to the caller.
extension SupabaseManager {

    /// POST one action to the `friends` function and return the raw body (throws a readable error).
    @discardableResult
    private func friendsCall(_ body: [String: String]) async throws -> Data {
        let url = URL(string: SupabaseConfig.url.absoluteString + "/functions/v1/friends")!
        let payload = try JSONSerialization.data(withJSONObject: body)
        let (data, http) = try await authedData { token in
            var req = URLRequest(url: url)
            req.httpMethod = "POST"
            req.setValue(SupabaseConfig.anonKey, forHTTPHeaderField: "apikey")
            req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.httpBody = payload
            return req
        }
        if let http, !(200..<300).contains(http.statusCode) {
            // The gateway's own 401 body has no `error` key — don't show its raw shape.
            let msg = (try? JSONDecoder().decode([String: String].self, from: data))?["error"]
                ?? Self.httpMessage(http.statusCode)
            throw NSError(domain: "Planfect.Friends", code: http.statusCode,
                          userInfo: [NSLocalizedDescriptionKey: msg])
        }
        return data
    }

    // MARK: Friends

    func friendsList() async throws -> FriendsList {
        let data = try await friendsCall(["action": "list"])
        let list = try JSONDecoder().decode(FriendsList.self, from: data)
        cacheFriends(list)
        return list
    }

    /// Refresh the cached list in the background — used to warm the Friends tab before it's opened
    /// and to revalidate after showing the cache. Failures are silent: the cache stays as it was.
    func prefetchFriends() async {
        _ = try? await friendsList()
    }

    /// The last list we successfully fetched, so opening the Friends tab paints immediately instead
    /// of spinning through a ~1s round trip. Survives relaunches; cleared on sign-out.
    var cachedFriends: FriendsList? {
        get {
            guard let uid = userId?.uuidString.lowercased(),
                  let data = UserDefaults.standard.data(forKey: Self.friendsCacheKey(uid)) else { return nil }
            return try? JSONDecoder().decode(FriendsList.self, from: data)
        }
        set {
            guard let uid = userId?.uuidString.lowercased() else { return }
            let key = Self.friendsCacheKey(uid)
            guard let newValue, let data = try? JSONEncoder().encode(newValue) else {
                UserDefaults.standard.removeObject(forKey: key); return
            }
            UserDefaults.standard.set(data, forKey: key)
        }
    }

    private func cacheFriends(_ list: FriendsList) { cachedFriends = list }

    /// Keyed per user so a second account on the same device never sees the first one's friends.
    static func friendsCacheKey(_ uid: String) -> String { "planfect.friends.\(uid)" }

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

    /// A friend's schedule for a date range — already blurred by tier on the server (regular
    /// friends get "Busy" only; close friends get specifics except blocks the owner marked private).
    func friendSchedule(_ target: UUID, from: Date, to: Date) async throws -> [FriendBlock] {
        let body = try JSONEncoder().encode([
            "target": target.uuidString.lowercased(),
            "from_ts": APIDate.iso(from),
            "to_ts": APIDate.iso(to),
        ])
        let data = try await rest("POST", "rpc/friend_schedule", body: body)
        return try JSONDecoder().decode([FriendBlock].self, from: data)
    }

    /// Mark one of my blocks private — friends then see only "Busy", even close ones.
    func setBlockPrivate(_ blockId: UUID, _ isPrivate: Bool) async throws {
        _ = try await rest("PATCH", "time_blocks?id=eq.\(blockId.uuidString)",
                           body: try JSONEncoder().encode(["is_private": isPrivate]), prefer: "return=minimal")
    }

    /// Register this device's APNs token so the backend can push friend + collaborative-plan alerts.
    func uploadDeviceToken(_ token: String) async {
        guard let uid = userId?.uuidString else { return }
        struct Row: Encodable { let user_id: String; let token: String; let platform: String }
        let body = try? JSONEncoder().encode([Row(user_id: uid, token: token, platform: "ios")])
        _ = try? await rest("POST", "device_tokens?on_conflict=user_id,token",
                            body: body, prefer: "resolution=merge-duplicates,return=minimal")
    }

    // MARK: Profile

    func fetchMyProfile() async throws -> MyProfile {
        guard let uid = userId?.uuidString else { throw profileError("Not signed in") }
        let data = try await rest("GET", "profiles?select=username,display_name,avatar_url&id=eq.\(uid)")
        guard let p = try JSONDecoder().decode([MyProfile].self, from: data).first else {
            throw profileError("Profile not found")
        }
        cachedProfile = p
        return p
    }

    /// The last profile we fetched, so the Profile sheet shows your name and photo in its first
    /// frame instead of the default silhouette. Survives relaunches; cleared on sign-out.
    var cachedProfile: MyProfile? {
        get {
            guard let uid = userId?.uuidString.lowercased(),
                  let data = UserDefaults.standard.data(forKey: Self.profileCacheKey(uid)) else { return nil }
            return try? JSONDecoder().decode(MyProfile.self, from: data)
        }
        set {
            guard let uid = userId?.uuidString.lowercased() else { return }
            let key = Self.profileCacheKey(uid)
            guard let newValue, let data = try? JSONEncoder().encode(newValue) else {
                UserDefaults.standard.removeObject(forKey: key); return
            }
            UserDefaults.standard.set(data, forKey: key)
        }
    }

    static func profileCacheKey(_ uid: String) -> String { "planfect.profile.\(uid)" }

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
        // LOWERCASE matters: the Storage RLS policy compares the folder name to `auth.uid()::text`,
        // which Postgres renders lowercase — while Swift's `UUID.uuidString` is UPPERCASE. Uploading
        // to `AB12…/avatar.jpg` fails the policy with a 403 "new row violates row-level security".
        guard let uid = userId?.uuidString.lowercased() else { throw profileError("Not signed in") }
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
        // We already have the exact bytes the new URL will serve — cache them under it, and point
        // the cached profile at it, so the new photo is on screen the instant you go back rather
        // than after a profile fetch plus an image download.
        if let url = URL(string: publicURL) { AvatarCache.store(jpeg, for: url) }
        if let p = cachedProfile {
            cachedProfile = MyProfile(username: p.username, display_name: p.display_name, avatar_url: publicURL)
        }
        return publicURL
    }

    private func profileError(_ msg: String) -> NSError {
        NSError(domain: "Planfect.Profile", code: 0, userInfo: [NSLocalizedDescriptionKey: msg])
    }
}
