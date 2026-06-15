import SwiftUI

/// Maps a block to a display category (label + icon + color). Uses the planner-assigned
/// `category` when present, falls back to keyword inference for older/uncategorized blocks,
/// and keeps structural kinds (commute/buffer/routine) as-is.
enum TaskCategory {
    static func of(_ block: TimeBlock) -> (label: String, icon: String, color: Color) {
        switch block.kind {
        case "commute": return ("Commute", "car.fill", .orange)
        case "buffer": return ("Buffer", "hourglass", .gray)
        case "routine": return ("Routine", "repeat", .purple)
        default: break
        }
        switch block.category ?? infer(block.title) {
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
        default: return ("Task", "checkmark.circle.fill", .accentColor)
        }
    }

    /// Resolved semantic key for a task block: the planner-assigned category, else inferred from
    /// the title. Shared by the pill and the reminder so they always agree.
    static func key(_ block: TimeBlock) -> String { block.category ?? infer(block.title) }

    /// Best-effort guess from the title (CN + EN) for blocks scheduled before categories existed.
    static func infer(_ title: String) -> String {
        let t = title.lowercased()
        func any(_ ks: [String]) -> Bool { ks.contains { t.contains($0) } }
        if any(["面试", "interview", "会议", "meeting", "开会", "工作", "上班", "报告", "report", "邮件", "email", "deadline"]) { return "work" }
        if any(["跑步", "run", "健身", "gym", "锻炼", "workout", "运动", "瑜伽", "yoga", "球", "swim", "游泳"]) { return "fitness" }
        if any(["吃", "饭", "lunch", "dinner", "breakfast", "咖啡", "coffee", "早餐", "午餐", "晚餐", "餐", "brunch"]) { return "meal" }
        if any(["看", "比赛", "电影", "movie", "游戏", "game", "剧", "演唱会", "concert", "直播", "放松", "relax", "tv"]) { return "leisure" }
        if any(["买", "购物", "shopping", "grocery", "groceries", "菜", "取", "快递", "errand", "邮局", "银行"]) { return "errand" }
        if any(["学", "study", "复习", "课", "class", "读", "read", "book", "作业", "homework", "练习"]) { return "learning" }
        if any(["医", "牙", "dentist", "doctor", "看病", "体检", "health", "checkup", "药"]) { return "health" }
        if any(["朋友", "friend", "聚", "party", "约", "social", "date", "约会"]) { return "social" }
        if any(["打扫", "清洁", "洗", "clean", "laundry", "家务", "chore", "整理"]) { return "chore" }
        if any(["机场", "airport", "flight", "航班", "出差", "travel", "trip", "火车", "train"]) { return "travel" }
        return "other"
    }
}
