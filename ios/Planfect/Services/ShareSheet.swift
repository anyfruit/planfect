import SwiftUI
import UIKit

/// SwiftUI wrapper around `UIActivityViewController` so exported files can go to the system
/// share sheet (AirDrop, Files, Mail, Calendar import, …).
struct ShareSheet: UIViewControllerRepresentable {
    let items: [Any]

    func makeUIViewController(context: Context) -> UIActivityViewController {
        UIActivityViewController(activityItems: items, applicationActivities: nil)
    }
    func updateUIViewController(_ controller: UIActivityViewController, context: Context) {}
}

/// Identifiable file reference so a freshly written export can drive `.sheet(item:)`.
struct ShareItem: Identifiable {
    let id = UUID()
    let url: URL
}
