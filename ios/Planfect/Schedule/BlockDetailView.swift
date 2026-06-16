import SwiftUI

/// Tap a schedule block to edit it: mark done, reschedule (date + time + duration), add a note,
/// or delete. Routine/commute blocks are read-mostly (no task note).
struct BlockDetailView: View {
    @EnvironmentObject var supa: SupabaseManager
    @Environment(\.dismiss) private var dismiss

    let block: TimeBlock
    let onChange: () -> Void

    @State private var title: String
    @State private var done: Bool
    @State private var start: Date
    @State private var durationMin: Int
    @State private var notes: String
    @State private var saving = false
    @State private var error: String?

    init(block: TimeBlock, onChange: @escaping () -> Void) {
        self.block = block
        self.onChange = onChange
        _title = State(initialValue: block.title)
        _done = State(initialValue: block.isDone)
        _start = State(initialValue: block.start)
        _durationMin = State(initialValue: block.durationMin)
        _notes = State(initialValue: block.notes)
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Title", text: $title, axis: .vertical)
                        .font(.headline).lineLimit(1...3)
                    Label(block.kind.capitalized, systemImage: kindIcon)
                        .font(.caption).foregroundStyle(.secondary)
                } header: {
                    Text("Title")
                }

                Section { Toggle("Done", isOn: $done) }

                Section("Time") {
                    DatePicker("Starts", selection: $start, displayedComponents: [.date, .hourAndMinute])
                    Stepper("Duration: \(durationMin) min", value: $durationMin, in: 5...600, step: 5)
                }

                if block.task_id != nil {
                    Section("Notes") {
                        TextField("Add a note", text: $notes, axis: .vertical).lineLimit(1...5)
                    }
                }

                if let error { Section { Text(error).foregroundStyle(.red).font(.footnote) } }

                Section {
                    Button(role: .destructive, action: remove) {
                        Label("Delete", systemImage: "trash").frame(maxWidth: .infinity)
                    }
                }
            }
            .navigationTitle("Edit").navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) { Button("Save", action: save).disabled(saving) }
            }
        }
    }

    private var kindIcon: String {
        switch block.kind {
        case "commute": return "car.fill"
        case "buffer": return "hourglass"
        case "routine": return "repeat"
        default: return "checkmark.circle"
        }
    }

    private func save() {
        saving = true; error = nil
        Task {
            do {
                let trimmed = title.trimmingCharacters(in: .whitespacesAndNewlines)
                if !trimmed.isEmpty && trimmed != block.title {
                    try await supa.setBlockTitle(block.id, taskId: block.task_id, trimmed)
                }
                if done != block.isDone { try await supa.setBlockDone(block.id, done) }
                if start != block.start || durationMin != block.durationMin {
                    try await supa.rescheduleBlock(block.id, start: start,
                                                   end: start.addingTimeInterval(Double(durationMin) * 60))
                }
                if let tid = block.task_id, notes != block.notes { try await supa.setNotes(tid, notes) }
                onChange()
                dismiss()
            } catch {
                self.error = error.localizedDescription
                saving = false
            }
        }
    }

    private func remove() {
        saving = true; error = nil
        Task {
            do { try await supa.deleteBlock(block); onChange(); dismiss() }
            catch { self.error = error.localizedDescription; saving = false }
        }
    }
}
