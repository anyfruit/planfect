import SwiftUI

struct ProfileView: View {
    @EnvironmentObject var supa: SupabaseManager
    @Environment(\.dismiss) private var dismiss
    @State private var routines: [Routine] = []

    var body: some View {
        NavigationStack {
            List {
                Section {
                    HStack(spacing: 14) {
                        Image(systemName: "person.crop.circle.fill")
                            .font(.system(size: 46)).foregroundStyle(.tint)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(supa.email ?? "Signed in").font(.headline)
                            Text("Planfect account").font(.caption).foregroundStyle(.secondary)
                        }
                    }
                    .padding(.vertical, 4)
                }

                Section("Your routine") {
                    if routines.isEmpty {
                        Text("No routine set yet").foregroundStyle(.secondary)
                    } else {
                        ForEach(routines) { r in
                            HStack {
                                Image(systemName: icon(r.kind)).foregroundStyle(.secondary).frame(width: 22)
                                Text(r.label)
                                Spacer()
                                Text("\(hhmm(r.start_time))–\(hhmm(r.end_time))")
                                    .foregroundStyle(.secondary).font(.callout.monospacedDigit())
                            }
                        }
                    }
                    Text("Edit routine — coming soon").font(.caption).foregroundStyle(.tertiary)
                }

                Section("Settings") {
                    LabeledContent("Timezone", value: TimeZone.current.identifier)
                    Text("Notifications, locations & maps — coming soon")
                        .font(.caption).foregroundStyle(.tertiary)
                }

                Section {
                    Button("Sign out", role: .destructive) {
                        Task { await supa.signOut(); dismiss() }
                    }
                }
            }
            .navigationTitle("Profile").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .topBarTrailing) { Button("Done") { dismiss() } } }
            .task { routines = (try? await supa.fetchRoutines()) ?? [] }
        }
    }

    private func icon(_ kind: String) -> String {
        switch kind {
        case "work": return "briefcase.fill"
        case "sleep": return "bed.double.fill"
        case "meal": return "fork.knife"
        case "commute": return "car.fill"
        default: return "clock.fill"
        }
    }

    private func hhmm(_ time: String) -> String { String(time.prefix(5)) }
}
