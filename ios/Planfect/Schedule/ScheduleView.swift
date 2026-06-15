import SwiftUI

enum ScheduleScope: String, CaseIterable, Identifiable {
    case day = "Day", week = "Week", month = "Month"
    var id: String { rawValue }
}

@MainActor
final class ScheduleViewModel: ObservableObject {
    @Published var blocks: [TimeBlock] = []
    @Published var loading = false
    @Published var error: String?

    private var supa: SupabaseManager?
    func bind(_ s: SupabaseManager) { if supa == nil { supa = s } }

    func load() async {
        guard let supa else { return }
        loading = true; error = nil
        do {
            blocks = try await supa.fetchBlocks()
            await NotificationManager.shared.reschedule(for: blocks)
        }
        catch { self.error = error.localizedDescription }
        loading = false
    }

    func toggleDone(_ block: TimeBlock) async {
        guard let supa else { return }
        do { try await supa.setBlockDone(block.id, !block.isDone); await load() }
        catch { self.error = error.localizedDescription }
    }

    func delete(_ block: TimeBlock) async {
        guard let supa else { return }
        do { try await supa.deleteBlock(block); await load() }
        catch { self.error = error.localizedDescription }
    }
}

struct ScheduleView: View {
    @EnvironmentObject var supa: SupabaseManager
    @EnvironmentObject var router: AppRouter
    @StateObject private var vm = ScheduleViewModel()
    @State private var scope: ScheduleScope = .day
    @State private var anchor = Date()
    @State private var selectedBlock: TimeBlock?

    var body: some View {
        VStack(spacing: 0) {
            Picker("Scope", selection: $scope) {
                ForEach(ScheduleScope.allCases) { Text($0.rawValue).tag($0) }
            }
            .pickerStyle(.segmented).padding([.horizontal, .top])

            HStack {
                Button { shift(-1) } label: { Image(systemName: "chevron.left") }
                Spacer()
                Text(periodLabel).font(.headline)
                Spacer()
                Button { shift(1) } label: { Image(systemName: "chevron.right") }
            }
            .padding()

            content
        }
        .navigationTitle("Schedule").navigationBarTitleDisplayMode(.inline)
        .onAppear {
            vm.bind(supa)
            if let day = router.jumpDay { anchor = day; scope = .day; router.jumpDay = nil }
            #if DEBUG
            if let s = ProcessInfo.processInfo.environment["PLANFECT_SCHEDULE_SCOPE"],
               let sc = ScheduleScope(rawValue: s.capitalized) { scope = sc }
            #endif
            Task { await vm.load() }
        }
        .onChange(of: router.jumpDay) { _, day in
            if let day { anchor = day; scope = .day; router.jumpDay = nil }
        }
        .refreshable { await vm.load() }
        .sheet(item: $selectedBlock) { block in
            BlockDetailView(block: block) { Task { await vm.load() } }
        }
    }

    @ViewBuilder private var content: some View {
        if vm.loading && vm.blocks.isEmpty {
            Spacer(); ProgressView(); Spacer()
        } else {
            switch scope {
            case .day:
                DayTimelineView(day: anchor, blocks: blocks(in: .day)) { selectedBlock = $0 }
            case .week:
                WeekTimelineView(weekStart: Self.range(.week, anchor).0, blocks: blocks(in: .week),
                                 onTapBlock: { selectedBlock = $0 },
                                 onTapDay: { anchor = $0; scope = .day })
            case .month:
                MonthGridView(month: anchor, blocks: blocks(in: .month),
                              onTapDay: { anchor = $0; scope = .day })
            }
        }
    }

    private func blocks(in scope: ScheduleScope) -> [TimeBlock] {
        let (start, end) = Self.range(scope, anchor)
        return vm.blocks.filter { $0.start >= start && $0.start < end }
    }

    private var periodLabel: String {
        switch scope {
        case .day: return anchor.formatted(.dateTime.weekday(.abbreviated).month().day())
        case .week:
            let (s, e) = Self.range(.week, anchor)
            let last = Calendar.current.date(byAdding: .day, value: -1, to: e) ?? e
            return "\(s.formatted(.dateTime.month().day())) – \(last.formatted(.dateTime.month().day()))"
        case .month: return anchor.formatted(.dateTime.month(.wide).year())
        }
    }

    private func shift(_ dir: Int) {
        let cal = Calendar.current
        let comp: Calendar.Component = scope == .day ? .day : (scope == .week ? .weekOfYear : .month)
        if let d = cal.date(byAdding: comp, value: dir, to: anchor) { anchor = d }
    }

    static func range(_ scope: ScheduleScope, _ anchor: Date) -> (Date, Date) {
        let cal = Calendar.current
        switch scope {
        case .day:
            let s = cal.startOfDay(for: anchor)
            return (s, cal.date(byAdding: .day, value: 1, to: s) ?? s)
        case .week:
            let s = cal.dateInterval(of: .weekOfYear, for: anchor)?.start ?? anchor
            return (s, cal.date(byAdding: .weekOfYear, value: 1, to: s) ?? s)
        case .month:
            let s = cal.dateInterval(of: .month, for: anchor)?.start ?? anchor
            return (s, cal.date(byAdding: .month, value: 1, to: s) ?? s)
        }
    }
}
