import WidgetKit
import SwiftUI

// MARK: - Timeline

struct PlanEntry: TimelineEntry {
    let date: Date
    let current: WidgetTask?       // task in progress at `date`
    let upcoming: [WidgetTask]     // soonest tasks after `date`
    let remaining: Int             // total upcoming (for the "+N more" hint)
}

struct Provider: TimelineProvider {
    func placeholder(in context: Context) -> PlanEntry {
        let now = Date()
        return PlanEntry(date: now, current: nil, upcoming: [
            WidgetTask(id: "p1", title: "Dentist", start: now.addingTimeInterval(3600),
                       end: now.addingTimeInterval(5400), categoryKey: "health", isDone: false),
            WidgetTask(id: "p2", title: "Gym", start: now.addingTimeInterval(9000),
                       end: now.addingTimeInterval(12600), categoryKey: "fitness", isDone: false),
        ], remaining: 2)
    }

    func getSnapshot(in context: Context, completion: @escaping (PlanEntry) -> Void) {
        completion(entry(at: Date(), tasks: PlanfectWidgetStore.load()))
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<PlanEntry>) -> Void) {
        let tasks = PlanfectWidgetStore.load()
        let now = Date()
        // Recompute "current / next" at each upcoming boundary so the widget advances on its own.
        var bounds: Set<Date> = [now]
        for t in tasks {
            if t.start > now { bounds.insert(t.start) }
            if t.end > now { bounds.insert(t.end) }
        }
        let ordered = bounds.sorted().prefix(16)
        let entries = ordered.map { entry(at: $0, tasks: tasks) }
        let cal = Calendar.current
        let nextMidnight = cal.startOfDay(for: cal.date(byAdding: .day, value: 1, to: now) ?? now)
        let reloadAt = ordered.last.flatMap { $0 > now ? $0.addingTimeInterval(1) : nil } ?? nextMidnight
        completion(Timeline(entries: entries.isEmpty ? [entry(at: now, tasks: tasks)] : entries,
                            policy: .after(reloadAt)))
    }

    private func entry(at date: Date, tasks: [WidgetTask]) -> PlanEntry {
        let current = tasks.first { $0.start <= date && $0.end > date && !$0.isDone }
        let upcoming = tasks.filter { $0.start > date && !$0.isDone }
        return PlanEntry(date: date, current: current, upcoming: Array(upcoming.prefix(3)), remaining: upcoming.count)
    }
}

// MARK: - Views

struct PlanfectWidgetEntryView: View {
    @Environment(\.widgetFamily) private var family
    let entry: PlanEntry

    var body: some View {
        switch family {
        case .accessoryInline: inline
        case .accessoryCircular: circular
        case .accessoryRectangular: rectangular
        case .systemMedium: medium
        default: small
        }
    }

    private var hasNothing: Bool { entry.current == nil && entry.upcoming.isEmpty }
    private var headline: WidgetTask? { entry.current ?? entry.upcoming.first }

    // Home screen — small: the one thing happening now or next.
    private var small: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            Spacer(minLength: 6)
            if let t = headline {
                Text(entry.current != nil ? "Now" : "Next")
                    .font(.caption2.weight(.heavy)).foregroundStyle(CategoryStyle.of(t.categoryKey).color)
                Text(t.title).font(.headline).lineLimit(2).minimumScaleFactor(0.8)
                Text(timeText(t)).font(.caption).foregroundStyle(.secondary)
            } else {
                emptyState
            }
            Spacer(minLength: 4)
            if entry.remaining > (entry.current == nil ? 1 : 0) {
                Text(moreText(entry.remaining - (entry.current == nil ? 1 : 0)))
                    .font(.caption2).foregroundStyle(.secondary)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .containerBackground(for: .widget) { gradient }
    }

    // Home screen — medium: a mini agenda.
    private var medium: some View {
        VStack(alignment: .leading, spacing: 7) {
            HStack {
                header
                Spacer()
                if entry.remaining > 0 {
                    Text(remainingText(entry.remaining)).font(.caption2).foregroundStyle(.secondary)
                }
            }
            if hasNothing {
                Spacer(); emptyState.frame(maxWidth: .infinity, alignment: .center); Spacer()
            } else {
                let rows = ([entry.current].compactMap { $0 } + entry.upcoming).prefix(3)
                ForEach(Array(rows)) { t in agendaRow(t, isNow: t.id == entry.current?.id) }
                Spacer(minLength: 0)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .containerBackground(for: .widget) { gradient }
    }

    private func agendaRow(_ t: WidgetTask, isNow: Bool) -> some View {
        HStack(spacing: 8) {
            RoundedRectangle(cornerRadius: 2).fill(CategoryStyle.of(t.categoryKey).color).frame(width: 4, height: 26)
            VStack(alignment: .leading, spacing: 1) {
                Text(t.title).font(.subheadline.weight(.medium)).lineLimit(1)
                Text(timeText(t)).font(.caption2).foregroundStyle(.secondary)
            }
            Spacer()
            if isNow {
                Text("Now").font(.caption2.weight(.bold)).foregroundStyle(CategoryStyle.of(t.categoryKey).color)
            } else {
                Image(systemName: CategoryStyle.of(t.categoryKey).icon)
                    .font(.caption).foregroundStyle(CategoryStyle.of(t.categoryKey).color)
            }
        }
    }

    // Lock screen — rectangular.
    private var rectangular: some View {
        VStack(alignment: .leading, spacing: 1) {
            if let t = headline {
                Text(entry.current != nil ? "Now" : "Next").font(.caption2.weight(.bold))
                Text(t.title).font(.headline).lineLimit(1)
                Text(timeText(t)).font(.caption2).foregroundStyle(.secondary)
            } else {
                Label("Planfect", systemImage: "sparkles").font(.caption)
                Text("Nothing planned").font(.caption2).foregroundStyle(.secondary)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .containerBackground(for: .widget) { Color.clear }
    }

    // Lock screen — inline (one line above the clock).
    private var inline: some View {
        if let t = headline {
            Label("\(WidgetTimeFormat.short(t.start, t.zone)) \(t.title)", systemImage: "calendar")
        } else {
            Label("No plans yet", systemImage: "sparkles")
        }
    }

    // Lock screen — circular: count of what's left.
    private var circular: some View {
        ZStack {
            AccessoryWidgetBackground()
            VStack(spacing: 0) {
                Image(systemName: "calendar").font(.caption2)
                Text("\(entry.remaining)").font(.system(.title3, design: .rounded).weight(.semibold))
            }
        }
        .containerBackground(for: .widget) { Color.clear }
    }

    // MARK: bits

    private var header: some View {
        HStack(spacing: 4) {
            Image(systemName: "sparkles").font(.caption2).foregroundStyle(CategoryStyle.brand)
            Text("Planfect").font(.caption2.weight(.bold)).foregroundStyle(CategoryStyle.brand)
        }
    }

    private var emptyState: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text("All clear").font(.headline)
            Text("Open Planfect to plan your day.").font(.caption2).foregroundStyle(.secondary).lineLimit(2)
        }
    }

    private var gradient: some View {
        LinearGradient(colors: [Color(.systemBackground), CategoryStyle.brand.opacity(0.12)],
                       startPoint: .top, endPoint: .bottom)
    }

    private func timeText(_ t: WidgetTask) -> String {
        "\(WidgetTimeFormat.short(t.start, t.zone)) – \(WidgetTimeFormat.short(t.end, t.zone))"
    }
    private func moreText(_ n: Int) -> String { String(format: NSLocalizedString("+%lld more", comment: ""), n) }
    private func remainingText(_ n: Int) -> String { String(format: NSLocalizedString("%lld left today", comment: ""), n) }
}

// MARK: - Widget

struct PlanfectWidget: Widget {
    let kind = "PlanfectWidget"
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: kind, provider: Provider()) { entry in
            PlanfectWidgetEntryView(entry: entry)
        }
        .configurationDisplayName("Planfect")
        .description("Your next plans, at a glance.")
        .supportedFamilies([.systemSmall, .systemMedium, .accessoryInline, .accessoryCircular, .accessoryRectangular])
    }
}

@main
struct PlanfectWidgetBundle: WidgetBundle {
    var body: some Widget { PlanfectWidget() }
}
