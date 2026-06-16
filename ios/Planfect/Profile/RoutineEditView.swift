import SwiftUI

/// Add or edit one routine block (work / sleep / meal / commute / custom): its label, which days
/// it applies to, and its start/end time. Per-day differences are just separate routine rows.
struct RoutineEditView: View {
    @EnvironmentObject var supa: SupabaseManager
    @Environment(\.dismiss) private var dismiss

    let existing: Routine?
    let onChange: () -> Void

    @State private var label: String
    @State private var kind: String
    @State private var days: Set<Int>
    @State private var start: Date
    @State private var end: Date
    @State private var saving = false
    @State private var error: String?

    private static let kinds = ["work", "sleep", "meal", "commute", "custom"]

    init(existing: Routine?, onChange: @escaping () -> Void) {
        self.existing = existing
        self.onChange = onChange
        _label = State(initialValue: existing?.label ?? "")
        _kind = State(initialValue: existing?.kind ?? "custom")
        _days = State(initialValue: Set(existing?.days_of_week ?? [1, 2, 3, 4, 5]))
        _start = State(initialValue: Self.timeToDate(existing?.start_time) ?? Self.clock(9))
        _end = State(initialValue: Self.timeToDate(existing?.end_time) ?? Self.clock(10))
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Label (e.g. Work, Gym, Lunch)", text: $label)
                    Picker("Type", selection: $kind) {
                        ForEach(Self.kinds, id: \.self) { Text(LocalizedStringKey($0.capitalized)).tag($0) }
                    }
                }
                Section("Days") { WeekdayChips(selection: $days) }
                Section("Time") {
                    DatePicker("Starts", selection: $start, displayedComponents: .hourAndMinute)
                    DatePicker("Ends", selection: $end, displayedComponents: .hourAndMinute)
                }
                if let error { Section { Text(error).foregroundStyle(.red).font(.footnote) } }
                if existing != nil {
                    Section {
                        Button(role: .destructive, action: remove) {
                            Label("Delete", systemImage: "trash").frame(maxWidth: .infinity)
                        }
                    }
                }
            }
            .navigationTitle(existing == nil ? "Add routine" : "Edit routine")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save", action: save).disabled(saving || label.isEmpty || days.isEmpty)
                }
            }
        }
    }

    private func save() {
        saving = true; error = nil
        Task {
            guard let uid = supa.userId?.uuidString else { saving = false; return }
            let r = RoutineInsert(user_id: uid, label: label, kind: kind, days_of_week: days.sorted(),
                                  start_time: Self.hhmmss(start), end_time: Self.hhmmss(end), is_flexible: false)
            do {
                if let e = existing { try await supa.updateRoutine(e.id, r) } else { try await supa.addRoutine(r) }
                onChange()
                dismiss()
            } catch {
                self.error = error.localizedDescription
                saving = false
            }
        }
    }

    private func remove() {
        guard let e = existing else { return }
        saving = true; error = nil
        Task {
            do { try await supa.deleteRoutine(e.id); onChange(); dismiss() }
            catch { self.error = error.localizedDescription; saving = false }
        }
    }

    private static func clock(_ h: Int) -> Date {
        Calendar.current.date(bySettingHour: h, minute: 0, second: 0, of: Date()) ?? Date()
    }
    private static func timeToDate(_ hhmmss: String?) -> Date? {
        guard let p = hhmmss?.split(separator: ":").compactMap({ Int($0) }), p.count >= 2 else { return nil }
        return Calendar.current.date(bySettingHour: p[0], minute: p[1], second: 0, of: Date())
    }
    private static func hhmmss(_ d: Date) -> String {
        let c = Calendar.current.dateComponents([.hour, .minute], from: d)
        return String(format: "%02d:%02d:00", c.hour ?? 0, c.minute ?? 0)
    }
}

/// Shared S–M–T–W–T–F–S day selector (0=Sun … 6=Sat).
struct WeekdayChips: View {
    @Binding var selection: Set<Int>
    private let labels = ["S", "M", "T", "W", "T", "F", "S"]

    var body: some View {
        HStack(spacing: 6) {
            ForEach(0..<7, id: \.self) { i in
                let on = selection.contains(i)
                Text(labels[i])
                    .font(.subheadline.bold())
                    .frame(width: 34, height: 34)
                    .background(on ? Color.accentColor : Color(.secondarySystemBackground), in: Circle())
                    .foregroundStyle(on ? Color.white : Color.primary)
                    .onTapGesture { if on { selection.remove(i) } else { selection.insert(i) } }
            }
        }
        .frame(maxWidth: .infinity)
    }
}
