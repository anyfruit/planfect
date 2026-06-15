import SwiftUI

struct ProfileView: View {
    @EnvironmentObject var supa: SupabaseManager
    @Environment(\.dismiss) private var dismiss
    @State private var routines: [Routine] = []
    @State private var editing: Routine?
    @State private var addingNew = false

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

                Section {
                    ForEach(routines) { r in
                        Button { editing = r } label: {
                            HStack(spacing: 10) {
                                Image(systemName: icon(r.kind)).foregroundStyle(.secondary).frame(width: 22)
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(r.label).foregroundStyle(.primary)
                                    Text(daysLabel(r.days_of_week)).font(.caption).foregroundStyle(.secondary)
                                }
                                Spacer()
                                Text("\(hhmm(r.start_time))–\(hhmm(r.end_time))")
                                    .foregroundStyle(.secondary).font(.callout.monospacedDigit())
                                Image(systemName: "chevron.right").font(.caption2).foregroundStyle(.tertiary)
                            }
                        }
                        .swipeActions(edge: .trailing) {
                            Button(role: .destructive) {
                                Task { try? await supa.deleteRoutine(r.id); await reload() }
                            } label: { Label("Delete", systemImage: "trash") }
                        }
                    }
                    Button { addingNew = true } label: {
                        Label("Add to routine", systemImage: "plus.circle.fill")
                    }
                } header: {
                    Text("Your routine")
                } footer: {
                    Text("Tap to edit times or days. You can also just tell the assistant in chat.")
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
            .task { await reload() }
            .sheet(item: $editing) { r in RoutineEditView(existing: r) { Task { await reload() } } }
            .sheet(isPresented: $addingNew) { RoutineEditView(existing: nil) { Task { await reload() } } }
        }
    }

    private func reload() async { routines = (try? await supa.fetchRoutines()) ?? [] }

    private func daysLabel(_ days: [Int]) -> String {
        let s = days.sorted()
        if s == [0, 1, 2, 3, 4, 5, 6] { return "Every day" }
        if s == [1, 2, 3, 4, 5] { return "Weekdays" }
        if s == [0, 6] { return "Weekends" }
        let names = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
        return s.map { names[$0] }.joined(separator: " ")
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
