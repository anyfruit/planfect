import SwiftUI
import Charts

// "Insights" tab: how the user's time breaks down by category over a day / week / month.
// A donut shows the proportion, a custom legend the exact times, and (for week/month) a per-day
// stacked bar shows the trend. All colors come from TaskCategory so it matches the schedule.

@MainActor
final class InsightsViewModel: ObservableObject {
    @Published var blocks: [TimeBlock] = []
    @Published var loading = false

    private var supa: SupabaseManager?
    func bind(_ s: SupabaseManager) { if supa == nil { supa = s } }

    func load() async {
        guard let supa else { return }
        loading = true
        blocks = (try? await supa.fetchBlocks()) ?? blocks
        loading = false
    }
}

struct CategoryStat: Identifiable {
    let key: String, label: String, color: Color, minutes: Int
    var id: String { key }
}
struct DayCategoryStat: Identifiable {
    let day: Date, label: String, color: Color, minutes: Int
    let id = UUID()
}

/// Compact payload the `/insights` AI function reads.
struct InsightsSummary: Encodable {
    let period: String
    let scope: String
    let language: String
    let total_min: Int
    let tasks_done: Int
    let tasks_total: Int
    let categories: [Item]
    let per_day: [Day]
    struct Item: Encodable { let label: String; let minutes: Int }
    struct Day: Encodable { let day: String; let items: [Item] }
}

struct InsightsView: View {
    @EnvironmentObject var supa: SupabaseManager
    @StateObject private var vm = InsightsViewModel()
    @State private var scope: ScheduleScope = .week
    @State private var anchor = Date()
    @State private var analysis: String?
    @State private var analyzing = false
    @State private var analysisError: String?
    @State private var analysisGen = 0   // invalidates in-flight analyses on period change
    @State private var agg = Aggregate()

    var body: some View {
        VStack(spacing: 0) {
            Picker("Scope", selection: $scope) {
                ForEach(ScheduleScope.allCases) { Text(LocalizedStringKey($0.rawValue)).tag($0) }
            }
            .pickerStyle(.segmented).padding([.horizontal, .top])

            HStack {
                Button { shift(-1) } label: { Image(systemName: "chevron.left") }
                Spacer(); Text(periodLabel).font(.headline); Spacer()
                Button { shift(1) } label: { Image(systemName: "chevron.right") }
            }
            .padding()

            if vm.loading && vm.blocks.isEmpty {
                Spacer(); ProgressView(); Spacer()
            } else if stats.isEmpty {
                emptyState
            } else {
                ScrollViewReader { proxy in
                    ScrollView {
                        VStack(spacing: 16) {
                            summaryCard
                            donutCard
                            if scope != .day { dailyCard.id("daily") }
                            aiCard.id("ai")
                        }
                        .padding()
                    }
                    #if DEBUG
                    .task {
                        guard ProcessInfo.processInfo.environment["PLANFECT_INSIGHTS_SCROLL"] == "1" else { return }
                        try? await Task.sleep(nanoseconds: 9_000_000_000)   // let an auto-run analysis finish first
                        withAnimation { proxy.scrollTo("ai", anchor: .bottom) }
                    }
                    #endif
                }
            }
        }
        .navigationTitle("Insights").navigationBarTitleDisplayMode(.inline)
        .onAppear {
            vm.bind(supa)
            #if DEBUG
            if let s = ProcessInfo.processInfo.environment["PLANFECT_SCHEDULE_SCOPE"],
               let sc = ScheduleScope(rawValue: s.capitalized) { scope = sc }
            #endif
            Task {
                await vm.load()
                recomputeAgg()
                #if DEBUG
                if ProcessInfo.processInfo.environment["PLANFECT_INSIGHTS_AUTORUN"] == "1" { runAnalysis() }
                #endif
            }
        }
        .refreshable { await vm.load(); recomputeAgg() }
        .onChange(of: scope) { _, _ in analysisGen += 1; analyzing = false; analysis = nil; analysisError = nil; recomputeAgg() }
        .onChange(of: anchor) { _, _ in analysisGen += 1; analyzing = false; analysis = nil; analysisError = nil; recomputeAgg() }
    }

    // MARK: - AI analysis

    private var aiCard: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 6) {
                Image(systemName: "sparkles").foregroundStyle(.tint)
                Text("AI analysis").font(.subheadline.weight(.semibold))
                Spacer()
                if analysis != nil && !analyzing {
                    Button { runAnalysis() } label: { Image(systemName: "arrow.clockwise").font(.caption) }
                        .buttonStyle(.plain).foregroundStyle(.secondary)
                }
            }
            if analyzing {
                HStack(spacing: 8) { ProgressView(); Text("Reading your schedule…").font(.callout).foregroundStyle(.secondary) }
            } else if let analysis, !analysis.isEmpty {
                Text(analysis).font(.callout).textSelection(.enabled)
            } else {
                Text("Get a quick read of where your time goes — and a couple of gentle suggestions.")
                    .font(.callout).foregroundStyle(.secondary)
                Button { runAnalysis() } label: {
                    Label("Analyze with AI", systemImage: "sparkles").font(.callout.weight(.medium))
                }
                .buttonStyle(.borderedProminent)
            }
            if let analysisError { Text(analysisError).font(.caption).foregroundStyle(.red) }
        }
        .padding()
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            LinearGradient(colors: [Color.accentColor.opacity(0.10), Color.purple.opacity(0.08)],
                           startPoint: .topLeading, endPoint: .bottomTrailing),
            in: RoundedRectangle(cornerRadius: 16)
        )
        .overlay(RoundedRectangle(cornerRadius: 16).stroke(Color.accentColor.opacity(0.18), lineWidth: 0.5))
    }

    private func runAnalysis() {
        analyzing = true; analysisError = nil
        analysisGen += 1
        let gen = analysisGen
        Task {
            do {
                let text = try await supa.analyzeInsights(currentSummary())
                if gen == analysisGen { analysis = text }   // drop a result for a superseded period
            } catch {
                if gen == analysisGen { analysisError = error.uiMessage }
            }
            if gen == analysisGen { analyzing = false }
        }
    }

    private func currentSummary() -> InsightsSummary {
        InsightsSummary(
            period: periodLabel,
            scope: scope.rawValue,
            language: Locale.current.language.languageCode?.identifier ?? "en",
            total_min: totalMinutes,
            tasks_done: doneCount,
            tasks_total: taskCount,
            categories: stats.map { .init(label: $0.label, minutes: $0.minutes) },
            per_day: scope == .day ? [] : groupedDays()
        )
    }

    private func groupedDays() -> [InsightsSummary.Day] {
        let cal = Calendar.current
        let byDay = Dictionary(grouping: dailyStats) { cal.startOfDay(for: $0.day) }
        return byDay.keys.sorted().map { day in
            InsightsSummary.Day(day: day.formatted(.dateTime.month().day()),
                                items: byDay[day]!.map { .init(label: $0.label, minutes: $0.minutes) })
        }
    }

    // MARK: - Cards

    private var summaryCard: some View {
        HStack(spacing: 0) {
            metric(value: hm(totalMinutes), label: "planned", system: "clock.fill", tint: .accentColor)
            Divider().frame(height: 36)
            metric(value: "\(doneCount)/\(taskCount)", label: "tasks done", system: "checkmark.circle.fill", tint: .green)
            Divider().frame(height: 36)
            metric(value: topLabel, label: "most time", system: "crown.fill", tint: .orange)
        }
        .padding(.vertical, 14)
        .frame(maxWidth: .infinity)
        .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 16))
    }

    private func metric(value: String, label: LocalizedStringKey, system: String, tint: Color) -> some View {
        VStack(spacing: 3) {
            Image(systemName: system).foregroundStyle(tint).font(.subheadline)
            Text(value).font(.callout.weight(.semibold)).lineLimit(1).minimumScaleFactor(0.7)
            Text(label).font(.caption2).foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity)
    }

    private var donutCard: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("By category").font(.subheadline.weight(.semibold))
            Chart(stats) { s in
                SectorMark(angle: .value("Minutes", s.minutes), innerRadius: .ratio(0.62), angularInset: 1.5)
                    .cornerRadius(4)
                    .foregroundStyle(s.color)
            }
            .chartLegend(.hidden)
            .frame(height: 200)
            .overlay {
                VStack(spacing: 1) {
                    Text(hm(totalMinutes)).font(.title3.bold())
                    Text("total").font(.caption2).foregroundStyle(.secondary)
                }
            }
            LazyVGrid(columns: [GridItem(.flexible(), alignment: .leading), GridItem(.flexible(), alignment: .leading)], spacing: 9) {
                ForEach(stats) { s in
                    HStack(spacing: 6) {
                        Circle().fill(s.color).frame(width: 9, height: 9)
                        Text(LocalizedStringKey(s.label)).font(.caption).lineLimit(1)
                        Spacer(minLength: 4)
                        Text(hm(s.minutes)).font(.caption.weight(.medium)).foregroundStyle(.secondary)
                    }
                }
            }
        }
        .padding()
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 16))
    }

    private var dailyCard: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(scope == .week ? "Each day this week" : "Across the month").font(.subheadline.weight(.semibold))
            Chart(dailyStats) { d in
                BarMark(
                    x: .value("Day", d.day, unit: .day),
                    y: .value("Minutes", d.minutes)
                )
                .foregroundStyle(by: .value("Category", d.label))
                .cornerRadius(3)
            }
            .chartForegroundStyleScale(domain: stats.map(\.label), range: stats.map(\.color))
            .chartLegend(.hidden)
            .chartYAxis {
                AxisMarks(values: .automatic(desiredCount: 4)) { v in
                    AxisGridLine()
                    AxisValueLabel { if let m = v.as(Double.self) { Text(axisHours(m)) } }
                }
            }
            .frame(height: 200)
        }
        .padding()
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 16))
    }

    private var emptyState: some View {
        VStack(spacing: 10) {
            Spacer()
            Image(systemName: "chart.pie").font(.largeTitle)
                .foregroundStyle(LinearGradient(colors: [.accentColor, .purple], startPoint: .top, endPoint: .bottom))
            Text("Nothing to chart yet").font(.headline)
            Text("Plan a few things and come back — you'll see where your time goes.")
                .font(.subheadline).foregroundStyle(.secondary).multilineTextAlignment(.center)
            Spacer()
        }
        .padding()
    }

    // MARK: - Aggregation (computed ONCE into `agg` on data/scope change, not repeatedly per render)

    private struct Aggregate {
        var stats: [CategoryStat] = []
        var dailyStats: [DayCategoryStat] = []
        var totalMinutes = 0
        var taskCount = 0
        var doneCount = 0
        var topLabel = "—"
    }

    private var stats: [CategoryStat] { agg.stats }
    private var dailyStats: [DayCategoryStat] { agg.dailyStats }
    private var totalMinutes: Int { agg.totalMinutes }
    private var taskCount: Int { agg.taskCount }
    private var doneCount: Int { agg.doneCount }
    private var topLabel: String { agg.topLabel }

    private func recomputeAgg() {
        let (start, end) = ScheduleView.range(scope, anchor)
        let range = vm.blocks.filter { $0.start >= start && $0.start < end && $0.kind != "buffer" }
        let cal = Calendar.current

        var byCat: [String: (label: String, color: Color, min: Int)] = [:]
        var byDay: [Date: [String: (label: String, color: Color, min: Int)]] = [:]
        for b in range {                                  // single pass builds both groupings
            let k = TaskCategory.bucketKey(b)
            let style = TaskCategory.of(b)
            var c = byCat[k] ?? (style.label, style.color, 0); c.min += b.durationMin; byCat[k] = c
            let day = cal.startOfDay(for: b.start)
            var d = byDay[day] ?? [:]
            var dc = d[k] ?? (style.label, style.color, 0); dc.min += b.durationMin; d[k] = dc; byDay[day] = d
        }
        let stats = byCat.map { CategoryStat(key: $0.key, label: $0.value.label, color: $0.value.color, minutes: $0.value.min) }
            .filter { $0.minutes > 0 }.sorted { $0.minutes > $1.minutes }
        var daily: [DayCategoryStat] = []
        for (day, cats) in byDay { for (_, v) in cats { daily.append(DayCategoryStat(day: day, label: v.label, color: v.color, minutes: v.min)) } }
        let tasks = range.filter { $0.kind == "task" }
        agg = Aggregate(stats: stats, dailyStats: daily,
                        totalMinutes: stats.reduce(0) { $0 + $1.minutes },
                        taskCount: tasks.count, doneCount: tasks.filter { $0.isDone }.count,
                        topLabel: stats.first.map { NSLocalizedString($0.label, comment: "") } ?? "—")
    }

    // MARK: - Period nav

    private func shift(_ dir: Int) {
        let comp: Calendar.Component = scope == .day ? .day : (scope == .week ? .weekOfYear : .month)
        if let d = Calendar.current.date(byAdding: comp, value: dir, to: anchor) { anchor = d }
    }

    private var periodLabel: String {
        switch scope {
        case .day: return anchor.formatted(.dateTime.weekday(.abbreviated).month().day())
        case .week:
            let (s, e) = ScheduleView.range(.week, anchor)
            let last = Calendar.current.date(byAdding: .day, value: -1, to: e) ?? e
            return "\(s.formatted(.dateTime.month().day())) – \(last.formatted(.dateTime.month().day()))"
        case .month: return anchor.formatted(.dateTime.month(.wide).year())
        }
    }

    // MARK: - Formatting

    private func hm(_ min: Int) -> String {
        let h = min / 60, m = min % 60
        if h > 0 && m > 0 { return "\(h)h \(m)m" }
        if h > 0 { return "\(h)h" }
        return "\(m)m"
    }
    private func axisHours(_ minutes: Double) -> String {
        let h = minutes / 60
        return h >= 1 ? "\(Int(h))h" : "\(Int(minutes))m"
    }
}
