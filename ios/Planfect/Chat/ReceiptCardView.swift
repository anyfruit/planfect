import SwiftUI

/// The scheduling receipt. Times are formatted from the structured (UTC) timestamps into the
/// device's local time — so this is always correct even if the model's prose says otherwise.
struct ReceiptCardView: View {
    @EnvironmentObject var router: AppRouter
    let receipt: Receipt

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Label("Scheduled", systemImage: "checkmark.circle.fill")
                .font(.subheadline.bold()).foregroundStyle(.green)

            ForEach(receipt.items) { item in
                VStack(alignment: .leading, spacing: 3) {
                    Text(item.title).font(.subheadline.weight(.semibold))
                    if let range = timeRange(item) {
                        Text(range).font(.footnote).foregroundStyle(.secondary)
                    }
                    if let c = item.commute, let leave = APIDate.parse(c.leaveAt) {
                        Label("Leave \(ZonedFormat.time(leave, item.zone)) · \(c.mode), \(c.durationMin) min",
                              systemImage: commuteIcon(c.mode))
                            .font(.caption).foregroundStyle(.secondary)
                    }
                }
            }

            if !receipt.assumptions.isEmpty {
                Divider()
                Text(receipt.assumptions.joined(separator: " "))
                    .font(.caption).foregroundStyle(.secondary)
            }
            HStack(spacing: 4) {
                Image(systemName: "calendar")
                Text("Tap to view & edit in your schedule")
                Image(systemName: "chevron.right")
            }
            .font(.caption2).foregroundStyle(.tint)
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 16))
        .overlay(RoundedRectangle(cornerRadius: 16).stroke(Color.green.opacity(0.3)))
        .contentShape(Rectangle())
        .onTapGesture { openInSchedule() }
    }

    private func openInSchedule() {
        if let day = receipt.items.compactMap({ $0.start.flatMap(APIDate.parse) }).first {
            router.openSchedule(on: Calendar.current.startOfDay(for: day))
        } else {
            router.tab = 1
        }
    }

    /// Glyph for the travel mode, so a drive doesn't show a walking figure (and vice-versa). The
    /// backend sends the real mode ("driving" for an airport run, etc.); fall back to transit.
    private func commuteIcon(_ mode: String) -> String {
        switch mode.lowercased() {
        case "driving", "car": return "car.fill"
        case "walking", "walk": return "figure.walk"
        case "cycling", "bicycling", "bike": return "bicycle"
        default: return "tram.fill"   // transit / unknown
        }
    }

    private func timeRange(_ item: ReceiptItem) -> String? {
        guard let start = item.start.flatMap(APIDate.parse) else { return nil }
        let z = item.zone   // render in the plan's own zone (per-event tz), not the device's
        let day = ZonedFormat.dayFull(start, z)
        let from = ZonedFormat.time(start, z)
        let hint = ZonedFormat.zoneHint(start, z).map { " \($0)" } ?? ""
        if let end = item.end.flatMap(APIDate.parse) {
            return "\(day) · \(from) – \(ZonedFormat.time(end, z))\(hint)"
        }
        return "\(day) · \(from)\(hint)"
    }
}
