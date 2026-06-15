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
        do { blocks = try await supa.fetchBlocks() }
        catch { self.error = error.localizedDescription }
        loading = false
    }
}

struct ScheduleView: View {
    @EnvironmentObject var supa: SupabaseManager
    @StateObject private var vm = ScheduleViewModel()
    @State private var scope: ScheduleScope = .day
    @State private var anchor = Date()

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

            if vm.loading && vm.blocks.isEmpty {
                Spacer(); ProgressView(); Spacer()
            } else if groups.isEmpty {
                emptyState
            } else {
                List {
                    ForEach(groups, id: \.day) { group in
                        Section(group.day.formatted(.dateTime.weekday(.wide).month().day())) {
                            ForEach(group.blocks) { BlockRow(block: $0) }
                        }
                    }
                }
                .listStyle(.insetGrouped)
            }
        }
        .navigationTitle("Schedule").navigationBarTitleDisplayMode(.inline)
        .onAppear { vm.bind(supa); Task { await vm.load() } }
        .refreshable { await vm.load() }
    }

    private var emptyState: some View {
        VStack(spacing: 10) {
            Spacer()
            Image(systemName: "calendar.day.timeline.left").font(.largeTitle).foregroundStyle(.secondary)
            Text("Nothing scheduled here").font(.headline)
            Text("Tell Planfect a plan in Chat and it'll show up on your timetable.")
                .font(.subheadline).foregroundStyle(.secondary).multilineTextAlignment(.center)
            Spacer()
        }
        .padding()
    }

    private struct DayGroup: Identifiable { let day: Date; let blocks: [TimeBlock]; var id: Date { day } }

    private var groups: [DayGroup] {
        let (start, end) = Self.range(scope, anchor)
        let cal = Calendar.current
        let inRange = vm.blocks.filter { $0.start >= start && $0.start < end }
        return Dictionary(grouping: inRange) { cal.startOfDay(for: $0.start) }
            .map { DayGroup(day: $0.key, blocks: $0.value.sorted { $0.start < $1.start }) }
            .sorted { $0.day < $1.day }
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

private struct BlockRow: View {
    let block: TimeBlock

    var body: some View {
        HStack(spacing: 12) {
            RoundedRectangle(cornerRadius: 3).fill(color).frame(width: 5, height: 40)
            VStack(alignment: .leading, spacing: 2) {
                Text(block.title).font(.subheadline.weight(.medium)).lineLimit(1)
                Text("\(block.start.formatted(date: .omitted, time: .shortened)) – \(block.end.formatted(date: .omitted, time: .shortened))")
                    .font(.caption).foregroundStyle(.secondary)
            }
            Spacer()
            Text(block.kind.capitalized)
                .font(.caption2).foregroundStyle(color)
                .padding(.horizontal, 7).padding(.vertical, 3)
                .background(color.opacity(0.15), in: Capsule())
        }
        .padding(.vertical, 2)
    }

    private var color: Color {
        switch block.kind {
        case "task": return .accentColor
        case "commute": return .orange
        case "buffer": return .gray
        case "routine": return .purple
        default: return .accentColor
        }
    }
}
