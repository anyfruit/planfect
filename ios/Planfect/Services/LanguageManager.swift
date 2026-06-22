import Foundation
import ObjectiveC

/// In-app UI language override with a LIVE switch (no relaunch). The chosen code — "" (follow the
/// device), "en", or "zh-Hans" — is saved in UserDefaults; a Bundle subclass redirects localized
/// lookups to the chosen `.lproj`, and the root view re-renders on the published change so every
/// string picks up the new language immediately.
@MainActor
final class LanguageManager: ObservableObject {
    static let shared = LanguageManager()
    static let key = "planfect.appLang"

    @Published private(set) var lang: String

    private init() {
        lang = UserDefaults.standard.string(forKey: Self.key) ?? ""
        Bundle.setPlanfectLanguage(lang)
    }

    /// Locale to push into the SwiftUI environment (drives date/number formatting + Text).
    var locale: Locale { lang.isEmpty ? .autoupdatingCurrent : Locale(identifier: lang) }

    func set(_ code: String) {
        guard code != lang else { return }
        lang = code
        UserDefaults.standard.set(code, forKey: Self.key)
        Bundle.setPlanfectLanguage(code)
        // Keep AppleLanguages in sync so system dialogs (and a relaunch) match the choice.
        if code.isEmpty { UserDefaults.standard.removeObject(forKey: "AppleLanguages") }
        else { UserDefaults.standard.set([code], forKey: "AppleLanguages") }
    }
}

// MARK: - Live-switchable main bundle

private var planfectBundleKey: UInt8 = 0

/// Reclasses `Bundle.main` so localized-string lookups can be redirected to a chosen `.lproj`
/// at runtime — the standard trick for switching language without relaunching.
private final class PlanfectLanguageBundle: Bundle, @unchecked Sendable {
    override func localizedString(forKey key: String, value: String?, table: String?) -> String {
        if let path = objc_getAssociatedObject(self, &planfectBundleKey) as? String,
           let bundle = Bundle(path: path) {
            return bundle.localizedString(forKey: key, value: value, table: table)
        }
        return super.localizedString(forKey: key, value: value, table: table)
    }
}

extension Bundle {
    static func setPlanfectLanguage(_ code: String) {
        object_setClass(Bundle.main, PlanfectLanguageBundle.self)
        let path = code.isEmpty ? nil : Bundle.main.path(forResource: code, ofType: "lproj")
        objc_setAssociatedObject(Bundle.main, &planfectBundleKey, path, .OBJC_ASSOCIATION_RETAIN)
    }
}
