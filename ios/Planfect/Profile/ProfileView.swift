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
    @State private var prefs: [Preference] = []
    @State private var addingPref = false
    @State private var newPref = ""
    @State private var recurring: [RecurringTask] = []
    @State private var showPaywall = false
    @State private var shareItem: ShareItem?
    @State private var exporting = false
    @AppStorage(NotificationManager.enabledKey) private var remindersEnabled = true
    @AppStorage(NotificationManager.leadKey) private var leadMin = 10
    @AppStorage(SpeechRecognizer.langKey) private var voiceLang = ""
    @AppStorage(CalendarManager.syncKey) private var calendarSync = false

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
                    Button { showPaywall = true } label: {
                        HStack(spacing: 10) {
                            Image(systemName: "sparkles").foregroundStyle(.tint).frame(width: 22)
                            Text("Planfect Pro").foregroundStyle(.primary)
                            Spacer()
                            Text(supa.isPro ? "Active" : "Free").foregroundStyle(.secondary)
                            Image(systemName: "chevron.right").font(.caption2).foregroundStyle(.tertiary)
                        }
                    }
                }

                Section {
                    ForEach(routines) { r in
                        Button { editing = r } label: {
                            HStack(spacing: 10) {
                                Image(systemName: icon(r.kind)).foregroundStyle(.secondary).frame(width: 22)
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(LocalizedStringKey(r.label)).foregroundStyle(.primary)
                                    Text(LocalizedStringKey(daysLabel(r.days_of_week))).font(.caption).foregroundStyle(.secondary)
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

                if !recurring.isEmpty {
                    Section {
                        ForEach(recurring) { r in
                            HStack(spacing: 10) {
                                Image(systemName: "repeat").foregroundStyle(.secondary).frame(width: 22)
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(r.title)
                                    HStack(spacing: 4) {
                                        Text(LocalizedStringKey(daysLabel(r.days_of_week)))
                                        Text("· \(String(r.start_local.prefix(5)))")
                                    }
                                    .font(.caption).foregroundStyle(.secondary)
                                }
                                Spacer()
                            }
                            .swipeActions(edge: .trailing) {
                                Button(role: .destructive) {
                                    Task { try? await supa.deleteRecurring(r.id); await reload() }
                                } label: { Label("Delete", systemImage: "trash") }
                            }
                        }
                    } header: {
                        Text("Recurring")
                    } footer: {
                        Text("Habits Planfect repeats for you. Swipe to stop one.")
                    }
                }

                Section {
                    if prefs.isEmpty {
                        Text("Nothing yet — as you plan, Planfect notes your habits here (e.g. \"workouts in the morning\") and applies them.")
                            .font(.caption).foregroundStyle(.secondary)
                    } else {
                        ForEach(prefs) { p in
                            HStack(spacing: 8) {
                                Image(systemName: "sparkles").font(.caption2).foregroundStyle(.tint)
                                Text(p.text).font(.callout)
                            }
                            .swipeActions(edge: .trailing) {
                                Button(role: .destructive) {
                                    Task { try? await supa.deletePreference(p.id); await reload() }
                                } label: { Label("Forget", systemImage: "trash") }
                            }
                        }
                    }
                    Button { addingPref = true } label: { Label("Add a preference", systemImage: "plus.circle.fill") }
                } header: {
                    Text("Planfect has learned")
                } footer: {
                    Text("Habits Planfect applies to every plan. Swipe to forget any, or add your own.")
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

                Section {
                    Picker("Language", selection: $voiceLang) {
                        Text("Auto (device)").tag("")
                        Text("中文").tag("zh-CN")
                        Text("English").tag("en-US")
                        Text("粤语 Cantonese").tag("zh-HK")
                        Text("日本語").tag("ja-JP")
                    }
                } header: {
                    Text("Voice input")
                } footer: {
                    Text("Language the mic uses for speech-to-text. \"Auto\" follows your device language.")
                }

                Section {
                    Toggle("Sync with Apple Calendar", isOn: $calendarSync.animation())
                } footer: {
                    Text("Plan around your real calendar events, and add Planfect's plans to your calendar.")
                }

                Section {
                    Button { export { try await supa.exportICS() } } label: {
                        HStack {
                            Label("Export schedule (.ics)", systemImage: "calendar.badge.plus")
                            if exporting { Spacer(); ProgressView() }
                        }
                    }
                    Button { export { try await supa.exportJSON() } } label: {
                        Label("Back up everything (.json)", systemImage: "arrow.down.doc")
                    }
                } header: {
                    Text("Export")
                } footer: {
                    Text("Send your schedule to any calendar app, or save a full backup of your routines, plans, and learned habits.")
                }
                .disabled(exporting)

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
            .sheet(isPresented: $showPaywall) { PaywallView() }
            .sheet(item: $shareItem) { item in ShareSheet(items: [item.url]) }
            .sheet(item: $editingPlace) { kind in
                AddressEditView(title: LocalizedStringKey(kind == .home ? "Home" : "Work"),
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
            .onChange(of: calendarSync) { _, on in if on { Task { _ = await CalendarManager.shared.ensureAccess() } } }
            .alert("Add a preference", isPresented: $addingPref) {
                TextField("e.g. Workouts in the morning", text: $newPref)
                Button("Cancel", role: .cancel) { newPref = "" }
                Button("Save") {
                    let t = newPref.trimmingCharacters(in: .whitespaces); newPref = ""
                    if !t.isEmpty { Task { try? await supa.addPreference(t); await reload() } }
                }
            } message: {
                Text("Planfect will apply this to your future plans.")
            }
        }
    }

    private func reload() async {
        routines = (try? await supa.fetchRoutines()) ?? []
        let hw = await supa.fetchHomeWork()
        homeAddr = hw.home ?? ""; workAddr = hw.work ?? ""
        prefs = await supa.fetchPreferences()
        recurring = await supa.fetchRecurring()
        await supa.refreshEntitlement()
    }

    @ViewBuilder
    private func placeRow(_ label: LocalizedStringKey, systemImage: String, value: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 10) {
                Image(systemName: systemImage).foregroundStyle(.secondary).frame(width: 22)
                Text(label).foregroundStyle(.primary)
                Spacer()
                (value.isEmpty ? Text("Add") : Text(value))
                    .foregroundStyle(value.isEmpty ? Color.accentColor : .secondary)
                    .lineLimit(1).truncationMode(.tail).frame(maxWidth: 170, alignment: .trailing)
                Image(systemName: "chevron.right").font(.caption2).foregroundStyle(.tertiary)
            }
        }
    }

    /// Run an export builder off the main actor, then hand the file to the share sheet.
    private func export(_ build: @escaping () async throws -> URL) {
        guard !exporting else { return }
        exporting = true
        Task {
            defer { exporting = false }
            if let url = try? await build() { shareItem = ShareItem(url: url) }
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
