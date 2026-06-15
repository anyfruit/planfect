import SwiftUI

struct ProfileView: View {
    @EnvironmentObject var supa: SupabaseManager
    @Environment(\.dismiss) private var dismiss
    @State private var routines: [Routine] = []
    @State private var editing: Routine?
    @State private var addingNew = false
    @State private var homeAddr = ""
    @State private var workAddr = ""
    @State private var editingPlace: PlaceKind?
    @AppStorage(NotificationManager.enabledKey) private var remindersEnabled = true
    @AppStorage(NotificationManager.leadKey) private var leadMin = 10

    private enum PlaceKind: String, Identifiable { case home, work; var id: String { rawValue } }

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

                Section {
                    placeRow("Home", systemImage: "house.fill", value: homeAddr) { editingPlace = .home }
                    placeRow("Work", systemImage: "briefcase.fill", value: workAddr) { editingPlace = .work }
                } header: {
                    Text("Places")
                } footer: {
                    Text("Planfect uses these to estimate real travel time to places you schedule.")
                }

                Section {
                    Toggle("Reminders", isOn: $remindersEnabled.animation())
                    if remindersEnabled {
                        Stepper(leadMin == 0 ? "Notify at start time" : "Notify \(leadMin) min before",
                                value: $leadMin, in: 0...60, step: 5)
                    }
                } header: {
                    Text("Reminders")
                } footer: {
                    Text("A nudge when it's time to head out, and before each task begins.")
                }

                Section("Settings") {
                    LabeledContent("Timezone", value: TimeZone.current.identifier)
                    Text("Locations & maps — coming soon")
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
            .sheet(item: $editingPlace) { kind in
                AddressEditView(title: kind == .home ? "Home" : "Work",
                                initial: kind == .home ? homeAddr : workAddr) { newVal in
                    Task {
                        try? await supa.saveHomeWork(home: kind == .home ? newVal : nil,
                                                     work: kind == .work ? newVal : nil)
                        await reload()
                    }
                }
            }
            .onChange(of: remindersEnabled) { _, on in
                Task {
                    if on { await NotificationManager.shared.ensureAuthorization(); await resyncReminders() }
                    else { NotificationManager.shared.cancelAll() }
                }
            }
            .onChange(of: leadMin) { _, _ in Task { await resyncReminders() } }
        }
    }

    private func reload() async {
        routines = (try? await supa.fetchRoutines()) ?? []
        let hw = await supa.fetchHomeWork()
        homeAddr = hw.home ?? ""; workAddr = hw.work ?? ""
    }

    @ViewBuilder
    private func placeRow(_ label: String, systemImage: String, value: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 10) {
                Image(systemName: systemImage).foregroundStyle(.secondary).frame(width: 22)
                Text(label).foregroundStyle(.primary)
                Spacer()
                Text(value.isEmpty ? "Add" : value)
                    .foregroundStyle(value.isEmpty ? Color.accentColor : .secondary)
                    .lineLimit(1).truncationMode(.tail).frame(maxWidth: 170, alignment: .trailing)
                Image(systemName: "chevron.right").font(.caption2).foregroundStyle(.tertiary)
            }
        }
    }

    /// Re-arm reminders from the live schedule after a settings change.
    private func resyncReminders() async {
        if let blocks = try? await supa.fetchBlocks() {
            await NotificationManager.shared.reschedule(for: blocks)
        }
    }

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
