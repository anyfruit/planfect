import WidgetKit
import SwiftUI

// MARK: - Timeline

struct PlanEntry: TimelineEntry {
    let date: Date
    let current: WidgetTask?       // task in progress at `date`
    let upcoming: [WidgetTask]     // soonest tasks after `date` (may spill into tomorrow)
    let remainingToday: Int        // upcoming NOT done, on the entry's calendar day only
    let doneToday: Int             // finished today (for the lock-screen gauge / large header)
    let totalToday: Int            // all of today's tasks
}

struct Provider: TimelineProvider {
    func placeholder(in context: Context) -> PlanEntry {
        let now = Date()
        return PlanEntry(date: now, current: nil, upcoming: [
            WidgetTask(id: "p1", title: "Dentist", start: now.addingTimeInterval(3600),
                       end: now.addingTimeInterval(5400), categoryKey: "health", isDone: false),
            WidgetTask(id: "p2", title: "Gym", start: now.addingTimeInterval(9000),
                       end: now.addingTimeInterval(12600), categoryKey: "fitness", isDone: false),
        ], remainingToday: 2, doneToday: 1, totalToday: 3)
    }

    func getSnapshot(in context: Context, completion: @escaping (PlanEntry) -> Void) {
        completion(entry(at: Date(), tasks: PlanfectWidgetStore.load()))
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<PlanEntry>) -> Void) {
        let tasks = PlanfectWidgetStore.load()
        let now = Date()
        // Recompute "current / next" at each upcoming boundary so the widget advances on its own.
        // (In-progress bars tick live via ProgressView(timerInterval:) — no extra entries needed.)
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
        let cal = Calendar.current
        let today = tasks.filter { cal.isDate($0.start, inSameDayAs: date) }
        let current = tasks.first { $0.start <= date && $0.end > date && !$0.isDone }
        let upcoming = tasks.filter { $0.start > date && !$0.isDone }
        return PlanEntry(
            date: date,
            current: current,
            upcoming: Array(upcoming.prefix(6)),
            remainingToday: upcoming.filter { cal.isDate($0.start, inSameDayAs: date) }.count,
            doneToday: today.filter(\.isDone).count,
            totalToday: today.count)
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
        case .systemLarge: large
        default: small
        }
    }

    private var hasNothing: Bool { entry.current == nil && entry.upcoming.isEmpty }
    private var headline: WidgetTask? { entry.current ?? entry.upcoming.first }

    // Home screen — small: the one thing happening now or next, with live progress.
    private var small: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            Spacer(minLength: 6)
            if let t = headline {
                let isNow = entry.current != nil
                Text(isNow ? "Now" : "Next")
                    .font(.caption2.weight(.heavy)).foregroundStyle(CategoryStyle.of(t.categoryKey).color)
                Text(t.title).font(.headline).lineLimit(2).minimumScaleFactor(0.8)
                Text(timeText(t)).font(.caption).foregroundStyle(.secondary)
                if isNow {
                    // Ticks on its own — WidgetKit animates timerInterval progress without new entries.
                    ProgressView(timerInterval: t.start...t.end, countsDown: false, label: {}, currentValueLabel: {})
                        .tint(CategoryStyle.of(t.categoryKey).color)
                        .padding(.top, 3)
                }
            } else {
                emptyState
            }
            Spacer(minLength: 4)
            if entry.remainingToday > (entry.current == nil ? 1 : 0) {
                Text(moreText(entry.remainingToday - (entry.current == nil ? 1 : 0)))
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
                if entry.remainingToday > 0 {
                    Text(remainingText(entry.remainingToday)).font(.caption2).foregroundStyle(.secondary)
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

    // Home screen — large: the day at a glance (agenda + done count).
    private var large: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                header
                Spacer()
                if entry.totalToday > 0 {
                    Text(doneText(entry.doneToday, entry.totalToday))
                        .font(.caption2).foregroundStyle(.secondary)
                }
            }
            if hasNothing {
                Spacer(); emptyState.frame(maxWidth: .infinity, alignment: .center); Spacer()
            } else {
                if let t = entry.current {
                    agendaRow(t, isNow: true)
                    ProgressView(timerInterval: t.start...t.end, countsDown: false, label: {}, currentValueLabel: {})
                        .tint(CategoryStyle.of(t.categoryKey).color)
                        .padding(.leading, 12)
                }
                ForEach(entry.upcoming) { t in agendaRow(t, isNow: false) }
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
            Label("\(timePrefix(t)) \(t.title)", systemImage: "calendar")
        } else {
            Label("No plans yet", systemImage: "sparkles")
        }
    }

    // Lock screen — circular: today's progress ring (done / total), falling back to a count.
    private var circular: some View {
        ZStack {
            AccessoryWidgetBackground()
            if entry.totalToday > 0 {
                Gauge(value: Double(entry.doneToday), in: 0...Double(max(entry.totalToday, 1))) {
                    Image(systemName: "calendar")
                } currentValueLabel: {
                    Text("\(entry.remainingToday)").font(.system(.title3, design: .rounded).weight(.semibold))
                }
                .gaugeStyle(.accessoryCircularCapacity)
            } else {
                VStack(spacing: 0) {
                    Image(systemName: "calendar").font(.caption2)
                    Text("0").font(.system(.title3, design: .rounded).weight(.semibold))
                }
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

    /// "3:00 – 4:00 PM", prefixed with a localized weekday ("Tue 9:00 –…") when the item is not on
    /// the entry's day — so a late-evening "Next" pointing at tomorrow can't read as today.
    private func timeText(_ t: WidgetTask) -> String {
        "\(timePrefix(t)) – \(WidgetTimeFormat.short(t.end, t.zone))"
    }
    private func timePrefix(_ t: WidgetTask) -> String {
        let time = WidgetTimeFormat.short(t.start, t.zone)
        if Calendar.current.isDate(t.start, inSameDayAs: entry.date) { return time }
        return "\(WidgetTimeFormat.dayShort(t.start, t.zone)) \(time)"
    }
    private func moreText(_ n: Int) -> String { String(format: NSLocalizedString("+%lld more", comment: ""), n) }
    private func remainingText(_ n: Int) -> String { String(format: NSLocalizedString("%lld left today", comment: ""), n) }
    private func doneText(_ done: Int, _ total: Int) -> String {
        String(format: NSLocalizedString("%lld of %lld done", comment: ""), done, total)
    }
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
        .supportedFamilies([.systemSmall, .systemMedium, .systemLarge,
                            .accessoryInline, .accessoryCircular, .accessoryRectangular])
    }
}

@main
struct PlanfectWidgetBundle: WidgetBundle {
    var body: some Widget { PlanfectWidget() }
}
