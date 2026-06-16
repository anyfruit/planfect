import SwiftUI

/// Placeholder Planfect Pro paywall. The feature list + entry points are real; actual purchase
/// (StoreKit / RevenueCat) is wired once the paid Apple Developer account is active. For testing,
/// a DEBUG-only toggle simulates an active subscription.
struct PaywallView: View {
    @EnvironmentObject var supa: SupabaseManager
    @Environment(\.dismiss) private var dismiss

    private let features: [(icon: String, text: LocalizedStringKey)] = [
        ("infinity", "Unlimited AI planning"),
        ("car.fill", "Real travel times"),
        ("magnifyingglass", "Live event & showtime lookups"),
        ("chart.pie.fill", "AI time analysis"),
        ("repeat", "Recurring habits"),
        ("calendar", "Apple Calendar sync"),
    ]
    private var brand: LinearGradient {
        LinearGradient(colors: [.accentColor, .purple], startPoint: .topLeading, endPoint: .bottomTrailing)
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 20) {
                    Image(systemName: "sparkles")
                        .font(.system(size: 30, weight: .bold)).foregroundStyle(.white)
                        .frame(width: 72, height: 72)
                        .background(brand, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
                    Text("Planfect Pro")
                        .font(.system(size: 28, weight: .heavy, design: .rounded))
                        .foregroundStyle(brand)
                    Text("Plan without limits.").font(.subheadline).foregroundStyle(.secondary)

                    VStack(alignment: .leading, spacing: 14) {
                        ForEach(features, id: \.icon) { f in
                            HStack(spacing: 12) {
                                Image(systemName: f.icon).foregroundStyle(.tint).frame(width: 26)
                                Text(f.text).font(.callout)
                                Spacer()
                                Image(systemName: "checkmark").font(.caption.bold()).foregroundStyle(.green)
                            }
                        }
                    }
                    .padding().background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 16))

                    if supa.isPro {
                        Label("You're on Pro", systemImage: "checkmark.seal.fill")
                            .foregroundStyle(.green).font(.headline)
                    } else {
                        Button {} label: {
                            Text("Upgrade").bold().frame(maxWidth: .infinity).padding(.vertical, 13)
                        }
                        .background(brand, in: Capsule()).foregroundStyle(.white).disabled(true)
                        Text("Subscriptions launching soon.").font(.footnote).foregroundStyle(.secondary)
                    }

                    #if DEBUG
                    Button(supa.isPro ? "Debug: turn Pro off" : "Debug: simulate Pro") {
                        Task { await supa.setPro(!supa.isPro) }
                    }
                    .font(.caption).foregroundStyle(.secondary)
                    #endif
                }
                .padding(24)
            }
            .navigationTitle("Planfect Pro").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Done") { dismiss() } } }
        }
    }
}
