import UIKit

/// On-disk cache for avatar images, so a face that has been seen once paints immediately instead of
/// re-downloading. `AsyncImage` alone always started from its placeholder — the default person icon
/// flashed for a beat on every visit, and after changing your own photo it looked like the change
/// hadn't taken.
///
/// Keyed by the full URL: avatar URLs carry a `?t=<upload time>` cache-buster, so a new photo is a
/// new key and can never be masked by the old image.
enum AvatarCache {
    private static let memory = NSCache<NSString, UIImage>()

    private static var directory: URL? {
        guard let base = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first else { return nil }
        let dir = base.appendingPathComponent("avatars", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }

    /// A filesystem-safe name for a URL. Hashed rather than escaped so the query string can't blow
    /// past the filename length limit.
    private static func file(for url: URL) -> URL? {
        directory?.appendingPathComponent(String(format: "%016llx", UInt64(bitPattern: Int64(url.absoluteString.hashValue))))
    }

    static func image(for url: URL) -> UIImage? {
        let key = url.absoluteString as NSString
        if let hit = memory.object(forKey: key) { return hit }
        guard let file = file(for: url),
              let data = try? Data(contentsOf: file),
              let img = UIImage(data: data) else { return nil }
        memory.setObject(img, forKey: key)
        return img
    }

    static func store(_ data: Data, for url: URL) {
        guard let img = UIImage(data: data) else { return }
        memory.setObject(img, forKey: url.absoluteString as NSString)
        if let file = file(for: url) { try? data.write(to: file, options: .atomic) }
    }

    /// Fetch (from cache, else the network) and cache. Returns nil if the image can't be loaded.
    static func load(_ url: URL) async -> UIImage? {
        if let hit = image(for: url) { return hit }
        guard let (data, resp) = try? await URLSession.shared.data(from: url),
              (resp as? HTTPURLResponse).map({ (200..<300).contains($0.statusCode) }) ?? true,
              let img = UIImage(data: data) else { return nil }
        store(data, for: url)
        return img
    }
}
