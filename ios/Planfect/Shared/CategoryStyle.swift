import SwiftUI

/// The single source of truth for how a category key looks (label + icon + color), keyed by a
/// plain string so it can be shared by the app (TaskCategory) and the widget extension without
/// dragging TimeBlock into the widget target. Covers semantic categories and structural kinds.
enum CategoryStyle {
    typealias Style = (label: String, icon: String, color: Color)

    /// Brand accent (indigo-violet, #6E54F0) — used as a literal so it resolves identically in the
    /// app and the widget extension (the widget has no AccentColor asset).
    static let brand = Color(red: 110 / 255, green: 84 / 255, blue: 240 / 255)

    static func of(_ key: String) -> Style {
        switch key {
        case "commute": return ("Commute", "car.fill", .orange)
        case "buffer": return ("Buffer", "hourglass", .gray)
        case "routine": return ("Routine", "repeat", .purple)
        case "work": return ("Work", "briefcase.fill", .blue)
        case "focus": return ("Focus", "target", .indigo)
        case "fitness": return ("Fitness", "figure.run", .green)
        case "meal": return ("Meal", "fork.knife", .orange)
        case "social": return ("Social", "person.2.fill", .pink)
        case "errand": return ("Errand", "bag.fill", .teal)
        case "leisure": return ("Leisure", "tv.fill", .purple)
        case "health": return ("Health", "cross.case.fill", .red)
        case "learning": return ("Learning", "book.fill", .brown)
        case "chore": return ("Chore", "house.fill", .gray)
        case "travel": return ("Travel", "airplane", .cyan)
        default: return ("Task", "checkmark.circle.fill", brand)
        }
    }
}
