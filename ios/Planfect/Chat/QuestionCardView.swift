import SwiftUI

/// Renders the planner's clarifying question(s) as tappable multiple-choice cards, each with an
/// always-present "Other" free-text option. Single- or multi-select. One "Send answer" commits all.
struct QuestionCardView: View {
    let questions: [PlanQuestion]
    let onSubmit: ([QuestionAnswer]) -> Void

    private static let otherKey = "\u{0001}other"

    @State private var picked: [String: Set<String>] = [:]   // question.id -> chosen option labels
    @State private var otherText: [String: String] = [:]
    @State private var submitted = false

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            ForEach(questions) { q in
                VStack(alignment: .leading, spacing: 8) {
                    Text(q.header.uppercased()).font(.caption2.bold()).foregroundStyle(.tint)
                    Text(q.question).font(.subheadline.weight(.medium))
                    ForEach(q.options) { opt in
                        OptionRow(title: opt.label, subtitle: opt.description,
                                  selected: isPicked(q, opt.label)) { toggle(q, opt.label) }
                    }
                    OtherRow(selected: isPicked(q, Self.otherKey),
                             text: Binding(get: { otherText[q.id] ?? "" }, set: { otherText[q.id] = $0 }),
                             onTap: { toggle(q, Self.otherKey) })
                }
            }
            Button(action: submit) {
                Text(submitted ? "Sent" : "Send answer").bold().frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .disabled(submitted || !allAnswered)
        }
        .padding(16)
        .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 16))
        .opacity(submitted ? 0.6 : 1)
    }

    private func isPicked(_ q: PlanQuestion, _ label: String) -> Bool { picked[q.id]?.contains(label) ?? false }

    private func toggle(_ q: PlanQuestion, _ label: String) {
        var set = picked[q.id] ?? []
        if q.multi_select {
            if set.contains(label) { set.remove(label) } else { set.insert(label) }
        } else {
            set = set.contains(label) ? [] : [label]
        }
        picked[q.id] = set
    }

    private var allAnswered: Bool {
        questions.allSatisfy { q in
            guard let set = picked[q.id], !set.isEmpty else { return false }
            if set.contains(Self.otherKey) && (otherText[q.id] ?? "").trimmingCharacters(in: .whitespaces).isEmpty {
                return false
            }
            return true
        }
    }

    private func submit() {
        let answers: [QuestionAnswer] = questions.map { q in
            let labels = (picked[q.id] ?? []).map { label -> String in
                label == Self.otherKey ? (otherText[q.id] ?? "").trimmingCharacters(in: .whitespaces) : label
            }
            return QuestionAnswer(question: q, selected: labels.filter { !$0.isEmpty })
        }
        submitted = true
        onSubmit(answers)
    }
}

private struct OptionRow: View {
    let title: String
    let subtitle: String
    let selected: Bool
    let onTap: () -> Void
    var body: some View {
        Button(action: onTap) {
            HStack(alignment: .top, spacing: 10) {
                Image(systemName: selected ? "checkmark.circle.fill" : "circle")
                    .foregroundStyle(selected ? Color.accentColor : Color.secondary)
                VStack(alignment: .leading, spacing: 1) {
                    Text(title).font(.subheadline.weight(.medium))
                    if !subtitle.isEmpty { Text(subtitle).font(.caption).foregroundStyle(.secondary) }
                }
                Spacer()
            }
            .padding(.vertical, 6).padding(.horizontal, 10)
            .background(selected ? Color.accentColor.opacity(0.12) : Color.clear, in: RoundedRectangle(cornerRadius: 10))
        }
        .buttonStyle(.plain)
    }
}

private struct OtherRow: View {
    let selected: Bool
    @Binding var text: String
    let onTap: () -> Void
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Button(action: onTap) {
                HStack(spacing: 10) {
                    Image(systemName: selected ? "checkmark.circle.fill" : "circle")
                        .foregroundStyle(selected ? Color.accentColor : Color.secondary)
                    Text("Other…").font(.subheadline.weight(.medium))
                    Spacer()
                }
                .padding(.vertical, 6).padding(.horizontal, 10)
            }
            .buttonStyle(.plain)
            if selected {
                TextField("Type your answer", text: $text)
                    .textFieldStyle(.roundedBorder).padding(.leading, 30)
            }
        }
    }
}
