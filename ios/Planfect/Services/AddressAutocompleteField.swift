import SwiftUI
import MapKit

/// A text field with live address autocomplete (Apple Maps, no API key needed). As the user types,
/// real address suggestions appear; tapping one fills in the full, disambiguated address — so they
/// get confirmation the place is real instead of typing a bare "1 Regency Plz" with no feedback.
@MainActor
final class AddressSearch: NSObject, ObservableObject, MKLocalSearchCompleterDelegate {
    @Published var results: [String] = []
    private let completer = MKLocalSearchCompleter()

    override init() {
        super.init()
        completer.delegate = self
        completer.resultTypes = .address
    }

    func query(_ s: String) {
        let t = s.trimmingCharacters(in: .whitespaces)
        guard t.count >= 3 else { results = []; return }
        completer.queryFragment = t
    }
    func clear() { results = [] }

    nonisolated func completerDidUpdateResults(_ c: MKLocalSearchCompleter) {
        let r = c.results.map { [$0.title, $0.subtitle].filter { !$0.isEmpty }.joined(separator: ", ") }
        Task { @MainActor in self.results = Array(r.prefix(4)) }
    }
    nonisolated func completer(_ c: MKLocalSearchCompleter, didFailWithError error: Error) {
        Task { @MainActor in self.results = [] }
    }
}

struct AddressAutocompleteField: View {
    let placeholder: String
    @Binding var text: String
    @StateObject private var search = AddressSearch()
    @State private var picked = false

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            TextField(placeholder, text: $text, axis: .vertical)
                .lineLimit(1...2)
                .padding(.horizontal, 14).padding(.vertical, 11)
                .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 12))
                .autocorrectionDisabled()
                .onChange(of: text) { _, v in
                    if picked { picked = false } else { search.query(v) }
                }
            ForEach(search.results, id: \.self) { r in
                Button {
                    picked = true; text = r; search.clear()
                } label: {
                    HStack(spacing: 8) {
                        Image(systemName: "mappin.circle.fill").foregroundStyle(.tint)
                        Text(r).font(.callout).foregroundStyle(.primary).multilineTextAlignment(.leading)
                        Spacer(minLength: 0)
                    }
                    .padding(.horizontal, 12).padding(.vertical, 8)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(Color(.tertiarySystemBackground), in: RoundedRectangle(cornerRadius: 10))
                }
                .buttonStyle(.plain)
            }
        }
    }
}
