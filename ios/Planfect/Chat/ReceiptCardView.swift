import SwiftUI

/// The scheduling receipt. Times are formatted from the structured (UTC) timestamps into the
/// device's local time — so this is always correct even if the model's prose says otherwise.
struct ReceiptCardView: View {
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
                        Label("Leave \(leave.formatted(date: .omitted, time: .shortened)) · \(c.mode), \(c.durationMin) min",
                              systemImage: "figure.walk")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                }
            }

            if !receipt.assumptions.isEmpty {
                Divider()
                Text(receipt.assumptions.joined(separator: " "))
                    .font(.caption).foregroundStyle(.secondary)
            }
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 16))
        .overlay(RoundedRectangle(cornerRadius: 16).stroke(Color.green.opacity(0.3)))
    }

    private func timeRange(_ item: ReceiptItem) -> String? {
        guard let start = item.start.flatMap(APIDate.parse) else { return nil }
        let day = start.formatted(.dateTime.weekday(.wide).month().day())
        let from = start.formatted(date: .omitted, time: .shortened)
        if let end = item.end.flatMap(APIDate.parse) {
            return "\(day) · \(from) – \(end.formatted(date: .omitted, time: .shortened))"
        }
        return "\(day) · \(from)"
    }
}
