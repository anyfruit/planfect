import SwiftUI

/// Tiny sheet for entering a Home/Work address. The planner uses it as the origin for
/// real travel-time estimates (Google Maps) when scheduling a task at a place.
struct AddressEditView: View {
    let title: String
    @State private var text: String
    let onSave: (String) -> Void
    @Environment(\.dismiss) private var dismiss

    init(title: String, initial: String, onSave: @escaping (String) -> Void) {
        self.title = title
        self._text = State(initialValue: initial)
        self.onSave = onSave
    }

    var body: some View {
        NavigationStack {
            Form {
                Section(title) {
                    TextField("Street, city", text: $text, axis: .vertical).lineLimit(1...3)
                }
                Section {
                    Text("Used to estimate real travel time to places you schedule.")
                        .font(.caption).foregroundStyle(.secondary)
                }
            }
            .navigationTitle(title).navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) { Button("Save") { onSave(text); dismiss() } }
            }
        }
    }
}
