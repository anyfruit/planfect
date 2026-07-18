import SwiftUI

/// Maps a block to a display category (label + icon + color). Uses the planner-assigned
/// `category` when present, falls back to keyword inference for older/uncategorized blocks,
/// and keeps structural kinds (commute/buffer/routine) as-is.
enum TaskCategory {
    typealias Style = (label: String, icon: String, color: Color)

    static func of(_ block: TimeBlock) -> Style { CategoryStyle.of(bucketKey(block)) }

    /// Resolved semantic key for a task block: the planner-assigned category, else inferred from
    /// the title. Shared by the pill, the timeline, the month dots and the reminders so they agree.
    static func key(_ block: TimeBlock) -> String { block.category ?? infer(block.title) }

    /// Grouping key for analytics: structural kinds keep their own bucket, tasks use `key`.
    static func bucketKey(_ block: TimeBlock) -> String {
        switch block.kind {
        case "commute": return "commute"
        case "buffer": return "buffer"
        case "routine": return "routine"
        default: return key(block)
        }
    }

    static func color(forKey key: String) -> Color { CategoryStyle.of(key).color }

    /// How a semantic category looks — delegates to the shared CategoryStyle (reused by the widget).
    static func style(forKey key: String) -> Style { CategoryStyle.of(key) }

    /// Best-effort guess from the title (CN + EN) for blocks scheduled before categories existed.
    static func infer(_ title: String) -> String {
        let t = title.lowercased()
        func any(_ ks: [String]) -> Bool { ks.contains { t.contains($0) } }
        if any(["面试", "interview", "会议", "meeting", "开会", "工作", "上班", "报告", "report", "邮件", "email", "deadline"]) { return "work" }
        if any(["跑步", "run", "健身", "gym", "锻炼", "workout", "运动", "瑜伽", "yoga", "球", "swim", "游泳"]) { return "fitness" }
        if any(["吃", "饭", "lunch", "dinner", "breakfast", "咖啡", "coffee", "早餐", "午餐", "晚餐", "餐", "brunch"]) { return "meal" }
        if any(["医", "牙", "dentist", "doctor", "看病", "体检", "health", "checkup", "药"]) { return "health" }
        if any(["看电影", "看剧", "看比赛", "比赛", "电影", "movie", "游戏", "game", "剧", "演唱会", "concert", "直播", "放松", "relax", "tv"]) { return "leisure" }
        if any(["买", "购物", "shopping", "grocery", "groceries", "菜", "取", "快递", "errand", "邮局", "银行"]) { return "errand" }
        if any(["学", "study", "复习", "课", "class", "读", "read", "book", "作业", "homework", "练习"]) { return "learning" }
        if any(["朋友", "friend", "聚", "party", "约", "social", "date", "约会"]) { return "social" }
        if any(["打扫", "清洁", "洗", "clean", "laundry", "家务", "chore", "整理"]) { return "chore" }
        if any(["机场", "airport", "flight", "航班", "出差", "travel", "trip", "火车", "train"]) { return "travel" }
        return "other"
    }
}
