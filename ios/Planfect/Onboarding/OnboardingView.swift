import SwiftUI

/// First-run setup: capture the fixed routine the planner schedules around (work/study + sleep),
/// so later "schedule this" requests automatically avoid those blocks.
struct OnboardingView: View {
    @EnvironmentObject var supa: SupabaseManager

    @State private var worksRegular = true
    @State private var workStart = time(9)
    @State private var workEnd = time(17)
    @State private var workDays: Set<Int> = [1, 2, 3, 4, 5]
    @State private var sleepStart = time(23)
    @State private var sleepEnd = time(7)
    @State private var saving = false
    @State private var error: String?

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Text("Let's learn your week")
                        .font(.title2.bold())
                    Text("Planfect schedules new tasks **around** these fixed blocks, so you never get double-booked over work or sleep. You can refine them anytime.")
                        .font(.subheadline).foregroundStyle(.secondary)
                }

                Section("Work / school") {
                    Toggle("I have regular hours", isOn: $worksRegular.animation())
                    if worksRegular {
                        DatePicker("Starts", selection: $workStart, displayedComponents: .hourAndMinute)
                        DatePicker("Ends", selection: $workEnd, displayedComponents: .hourAndMinute)
                        WeekdayPicker(selection: $workDays)
                    }
                }

                Section("Sleep") {
                    DatePicker("Bedtime", selection: $sleepStart, displayedComponents: .hourAndMinute)
                    DatePicker("Wake up", selection: $sleepEnd, displayedComponents: .hourAndMinute)
                }

                if let error {
                    Section { Text(error).foregroundStyle(.red).font(.footnote) }
                }

                Section {
                    Button(action: finish) {
                        HStack { if saving { ProgressView() }; Text("Start planning").bold() }
                            .frame(maxWidth: .infinity)
                    }
                    .disabled(saving)
                }
            }
            .navigationTitle("Welcome").navigationBarTitleDisplayMode(.inline)
        }
    }

    private func finish() {
        saving = true; error = nil
        Task {
            guard let uid = supa.userId?.uuidString else { saving = false; return }
            var routines: [RoutineInsert] = [
                RoutineInsert(user_id: uid, label: "Sleep", kind: "sleep",
                              days_of_week: [0, 1, 2, 3, 4, 5, 6],
                              start_time: hhmmss(sleepStart), end_time: hhmmss(sleepEnd), is_flexible: false),
            ]
            if worksRegular, !workDays.isEmpty {
                routines.append(RoutineInsert(user_id: uid, label: "Work", kind: "work",
                                              days_of_week: workDays.sorted(),
                                              start_time: hhmmss(workStart), end_time: hhmmss(workEnd),
                                              is_flexible: false))
            }
            do {
                try? await supa.setTimezone(TimeZone.current.identifier)
                try await supa.saveRoutines(routines)
                supa.needsOnboarding = false
            } catch {
                self.error = error.localizedDescription
                saving = false
            }
        }
    }
}

private struct WeekdayPicker: View {
    @Binding var selection: Set<Int>
    private let labels = ["S", "M", "T", "W", "T", "F", "S"]   // 0=Sun … 6=Sat

    var body: some View {
        HStack(spacing: 6) {
            ForEach(0..<7, id: \.self) { i in
                let on = selection.contains(i)
                Text(labels[i])
                    .font(.subheadline.bold())
                    .frame(width: 34, height: 34)
                    .background(on ? Color.accentColor : Color(.secondarySystemBackground), in: Circle())
                    .foregroundStyle(on ? Color.white : Color.primary)
                    .onTapGesture { if on { selection.remove(i) } else { selection.insert(i) } }
            }
        }
        .frame(maxWidth: .infinity)
    }
}

private func time(_ hour: Int) -> Date {
    Calendar.current.date(bySettingHour: hour, minute: 0, second: 0, of: Date()) ?? Date()
}

private func hhmmss(_ date: Date) -> String {
    let c = Calendar.current.dateComponents([.hour, .minute], from: date)
    return String(format: "%02d:%02d:00", c.hour ?? 0, c.minute ?? 0)
}
