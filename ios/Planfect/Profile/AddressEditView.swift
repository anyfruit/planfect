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
                    AddressAutocompleteField(placeholder: "Street, city", text: $text)
                }
                Section {
                    Text("Start typing and pick a suggestion so Planfect resolves the exact place for travel-time estimates.")
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
