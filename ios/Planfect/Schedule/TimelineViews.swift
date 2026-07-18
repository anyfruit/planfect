import SwiftUI

// Visual time-axis schedule: a day timeline with an hour ruler, a 7-column week grid, and a
// month calendar. Blocks are positioned by their start/duration and colored by category
// (TaskCategory). Tapping a block opens its detail sheet; tapping a day jumps to the day view.

// MARK: - Layout helpers

/// A block placed into a column ("lane") so overlapping blocks sit side by side.
struct LaidOutBlock: Identifiable {
    let block: TimeBlock
    let lane: Int        // column index within its overlap cluster
    let laneCount: Int   // number of columns in that cluster
    var id: UUID { block.id }
}

enum TimelineLayout {
    /// Greedy interval layout: blocks that overlap (transitively) form a cluster and are split
    /// into as many side-by-side columns as the cluster's peak concurrency.
    static func lanes(for blocks: [TimeBlock]) -> [LaidOutBlock] {
        let sorted = blocks.sorted { $0.start < $1.start }
        var out: [LaidOutBlock] = []
        var i = 0
        while i < sorted.count {
            // Extend the cluster while the next block starts before the cluster's running end.
            var clusterEnd = sorted[i].end
            var j = i + 1
            while j < sorted.count, sorted[j].start < clusterEnd {
                clusterEnd = max(clusterEnd, sorted[j].end)
                j += 1
            }
            let cluster = Array(sorted[i..<j])
            var laneEnds: [Date] = []          // running end-time of each open lane
            var assigned: [Int] = []
            for b in cluster {
                if let lane = laneEnds.firstIndex(where: { $0 <= b.start }) {
                    laneEnds[lane] = b.end; assigned.append(lane)
                } else {
                    laneEnds.append(b.end); assigned.append(laneEnds.count - 1)
                }
            }
            let count = laneEnds.count
            for (k, b) in cluster.enumerated() {
                out.append(LaidOutBlock(block: b, lane: assigned[k], laneCount: count))
            }
            i = j
        }
        return out
    }
}

enum TimelineMath {
    /// Minutes-from-midnight of `d` IN `zone` — positions a block at its own wall-clock (per-event tz),
    /// so a trip's plan sits where its planned time is, not where the device's clock would put it.
    static func minutes(_ d: Date, _ zone: TimeZone) -> CGFloat {
        var cal = Calendar.current; cal.timeZone = zone
        let c = cal.dateComponents([.hour, .minute], from: d)
        return CGFloat((c.hour ?? 0) * 60 + (c.minute ?? 0))
    }
    static func y(_ start: Date, _ zone: TimeZone, _ hourHeight: CGFloat) -> CGFloat {
        minutes(start, zone) / 60 * hourHeight
    }
    static func height(_ b: TimeBlock, _ hourHeight: CGFloat) -> CGFloat {
        max(22, CGFloat(max(15, b.durationMin)) / 60 * hourHeight)   // floor so short blocks stay tappable
    }
    static func firstHour(_ blocks: [TimeBlock]) -> Int {
        let h = blocks.map { Int(minutes($0.start, $0.zone) / 60) }.min()
        return max(0, (h ?? 8) - 1)
    }
}

// MARK: - Shared pieces

/// 24 hour rows with right-aligned labels and a hairline at the top of each hour.
private struct HourGrid: View {
    let hourHeight: CGFloat
    let ruler: CGFloat
    var body: some View {
        VStack(spacing: 0) {
            ForEach(0..<24, id: \.self) { h in
                HStack(alignment: .top, spacing: 6) {
                    Text(label(h)).font(.caption2).foregroundStyle(.tertiary)
                        .frame(width: ruler - 8, alignment: .trailing)
                    Rectangle().fill(Color(.separator).opacity(0.6)).frame(height: 0.5)
                        .frame(maxWidth: .infinity, alignment: .top)
                }
                .frame(height: hourHeight, alignment: .top)
                .id(h)
            }
        }
    }
    private func label(_ h: Int) -> String {
        if h == 0 { return "12 AM" }; if h == 12 { return "12 PM" }
        return h < 12 ? "\(h) AM" : "\(h - 12) PM"
    }
}

/// One block as a colored card. `compact` drops the time line for the narrow week columns.
private struct BlockCell: View {
    let block: TimeBlock
    let compact: Bool
    var body: some View {
        let cat = TaskCategory.of(block)
        HStack(spacing: 4) {
            RoundedRectangle(cornerRadius: 2).fill(cat.color).frame(width: 3)
            VStack(alignment: .leading, spacing: 1) {
                Text(block.title)
                    .font(compact ? .system(size: 9.5, weight: .medium) : .caption.weight(.medium))
                    .lineLimit(compact ? nil : 2)               // week: wrap to show the full name
                    .minimumScaleFactor(compact ? 0.7 : 1)      // shrink a touch before wrapping in tight blocks
                    .multilineTextAlignment(.leading)
                    .strikethrough(block.isDone)
                    .foregroundStyle(block.isDone ? Color.secondary : Color.primary)
                if !compact {
                    Text(ZonedFormat.time(block.start, block.zone))
                        .font(.caption2).foregroundStyle(.secondary)
                }
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, compact ? 3 : 5).padding(.vertical, compact ? 1 : 3)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(cat.color.opacity(block.isDone ? 0.08 : 0.16), in: RoundedRectangle(cornerRadius: 6))
        .overlay(RoundedRectangle(cornerRadius: 6).stroke(cat.color.opacity(0.35), lineWidth: 0.5))
        .opacity(block.isDone ? 0.55 : 1)
        .contentShape(Rectangle())
    }
}

private func isToday(_ d: Date) -> Bool { Calendar.current.isDateInToday(d) }

// MARK: - Week (Day uses the list layout in ScheduleView; this grid is for Week/Month)

struct WeekTimelineView: View {
    let weekStart: Date
    let blocks: [TimeBlock]
    let onTapBlock: (TimeBlock) -> Void
    let onTapDay: (Date) -> Void

    private let hourHeight: CGFloat = 46
    private let ruler: CGFloat = 40
    private var days: [Date] {
        (0..<7).compactMap { Calendar.current.date(byAdding: .day, value: $0, to: weekStart) }
    }
    /// Hour the view opens at: an hour before the week's earliest event, or 7 AM when empty.
    private var startHour: Int { TimelineMath.firstHour(blocks) }

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 0) {
                Spacer().frame(width: ruler)   // Spacer is greedy only along the stack axis, so it adds no height
                ForEach(days, id: \.self) { d in
                    Button { onTapDay(d) } label: {
                        VStack(spacing: 1) {
                            Text(d.formatted(.dateTime.weekday(.narrow)))
                                .font(.caption2).foregroundStyle(.secondary)
                            // Bare day number: .dateTime.day() localizes to "19日" in zh, which
                            // truncates to "1…" in the 24pt circle.
                            Text(String(Calendar.current.component(.day, from: d)))
                                .font(.caption.weight(isToday(d) ? .bold : .regular))
                                .foregroundStyle(isToday(d) ? Color.accentColor : .primary)
                                .frame(width: 24, height: 24)
                                .background(isToday(d) ? Color.accentColor.opacity(0.15) : .clear, in: Circle())
                        }
                        .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(.vertical, 5)
            Divider()

            ScrollViewReader { proxy in
                ScrollView {
                    ZStack(alignment: .topLeading) {
                        HourGrid(hourHeight: hourHeight, ruler: ruler)
                        GeometryReader { geo in
                            let colW = (geo.size.width - ruler) / 7
                            ForEach(Array(days.enumerated()), id: \.offset) { idx, d in
                                let dayBlocks = blocks.filter { Calendar.current.isDate($0.start, inSameDayAs: d) }
                                ForEach(TimelineLayout.lanes(for: dayBlocks)) { lo in
                                    let laneW = colW / CGFloat(lo.laneCount)
                                    let h = TimelineMath.height(lo.block, hourHeight)
                                    BlockCell(block: lo.block, compact: true)
                                        .frame(width: max(0, laneW - 2), height: h)
                                        .position(x: ruler + colW * CGFloat(idx) + laneW * (CGFloat(lo.lane) + 0.5),
                                                  y: TimelineMath.y(lo.block.start, lo.block.zone, hourHeight) + h / 2)
                                        .onTapGesture { onTapBlock(lo.block) }
                                }
                            }
                        }
                    }
                    .frame(height: hourHeight * 24)
                    .padding(.vertical, 6)
                }
                // Open at the first event (or working hours when empty), not 12 AM. scrollTo in a
                // bare onAppear is a no-op — layout isn't done yet — so defer a tick; and blocks
                // load async, so also re-anchor when the earliest hour changes (initial load / week
                // flips), which leaves a user's manual scrolling alone otherwise.
                .onAppear {
                    let h = startHour
                    DispatchQueue.main.async { proxy.scrollTo(h, anchor: .top) }
                }
                .onChange(of: startHour) { _, h in proxy.scrollTo(h, anchor: .top) }
            }
        }
    }
}

// MARK: - Month

struct MonthGridView: View {
    let month: Date
    let blocks: [TimeBlock]
    let onTapDay: (Date) -> Void

    private var cal: Calendar { Calendar.current }

    var body: some View {
        VStack(spacing: 6) {
            HStack(spacing: 4) {
                ForEach(Array(headerSymbols.enumerated()), id: \.offset) { _, s in
                    Text(s).font(.caption2.weight(.medium)).foregroundStyle(.secondary).frame(maxWidth: .infinity)
                }
            }
            ForEach(Array(weeks.enumerated()), id: \.offset) { _, week in
                HStack(spacing: 4) {
                    ForEach(Array(week.enumerated()), id: \.offset) { _, day in
                        if let day {
                            DayCell(day: day, colors: categoryColors(for: day), today: isToday(day))
                                .onTapGesture { onTapDay(day) }
                        } else {
                            Color.clear.frame(maxWidth: .infinity).frame(height: 56)   // fixed height: not greedy
                        }
                    }
                }
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal).padding(.top, 8)
    }

    // Up to four distinct category colors present that day (preserving schedule order).
    private func categoryColors(for day: Date) -> [Color] {
        let dayBlocks = blocks.filter { cal.isDate($0.start, inSameDayAs: day) }.sorted { $0.start < $1.start }
        var seen: [String] = []
        for b in dayBlocks where !seen.contains(TaskCategory.key(b)) { seen.append(TaskCategory.key(b)) }
        return seen.prefix(4).map { TaskCategory.color(forKey: $0) }
    }

    private var headerSymbols: [String] {
        let s = cal.veryShortStandaloneWeekdaySymbols          // index 0 = Sunday
        return (0..<7).map { s[(cal.firstWeekday - 1 + $0) % 7] }
    }

    private var gridDays: [Date?] {
        guard let interval = cal.dateInterval(of: .month, for: month),
              let count = cal.range(of: .day, in: .month, for: month)?.count else { return [] }
        let first = interval.start
        let leading = (cal.component(.weekday, from: first) - cal.firstWeekday + 7) % 7
        var cells: [Date?] = Array(repeating: nil, count: leading)
        for d in 0..<count { cells.append(cal.date(byAdding: .day, value: d, to: first)) }
        while cells.count % 7 != 0 { cells.append(nil) }
        return cells
    }

    private var weeks: [[Date?]] {
        stride(from: 0, to: gridDays.count, by: 7).map { Array(gridDays[$0..<min($0 + 7, gridDays.count)]) }
    }
}

private struct DayCell: View {
    let day: Date
    let colors: [Color]
    let today: Bool
    var body: some View {
        VStack(spacing: 4) {
            // Bare number — .dateTime.day() is "19日" in zh, which truncates in the 28pt circle.
            Text(String(Calendar.current.component(.day, from: day)))
                .font(.callout.weight(today ? .bold : .regular))
                .foregroundStyle(today ? Color.white : .primary)
                .frame(width: 28, height: 28)
                .background(today ? Color.accentColor : .clear, in: Circle())
            HStack(spacing: 3) {
                ForEach(Array(colors.enumerated()), id: \.offset) { _, c in
                    Circle().fill(c).frame(width: 5, height: 5)
                }
            }
            .frame(height: 6)
        }
        .frame(maxWidth: .infinity).frame(height: 56)
        .contentShape(Rectangle())
    }
}
