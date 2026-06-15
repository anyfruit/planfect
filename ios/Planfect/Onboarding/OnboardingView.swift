import SwiftUI

/// First-run setup. Everything is adjustable — pick your real work hours and days, sleep times,
/// which meals you eat and when, and your commute. The planner schedules tasks around all of it.
struct OnboardingView: View {
    @EnvironmentObject var supa: SupabaseManager

    @State private var hasWork = true
    @State private var workStart = clock(9, 0)
    @State private var workEnd = clock(17, 0)
    @State private var workDays: Set<Int> = [1, 2, 3, 4, 5]
    @State private var commuteMin = 0

    @State private var bedtime = clock(23, 0)
    @State private var wake = clock(7, 0)

    @State private var hasBreakfast = true
    @State private var breakfast = clock(8, 0)
    @State private var hasLunch = true
    @State private var lunch = clock(12, 30)
    @State private var hasDinner = true
    @State private var dinner = clock(18, 30)

    @State private var homeAddress = ""
    @State private var workAddress = ""

    @State private var saving = false
    @State private var error: String?

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Text("Let's set up your week").font(.title3.bold())
                    Text("I'll fit your tasks around these. All of it is adjustable anytime in your profile.")
                        .font(.subheadline).foregroundStyle(.secondary)
                }

                Section("Work / school") {
                    Toggle("I have regular hours", isOn: $hasWork.animation())
                    if hasWork {
                        DatePicker("Starts", selection: $workStart, displayedComponents: .hourAndMinute)
                        DatePicker("Ends", selection: $workEnd, displayedComponents: .hourAndMinute)
                        VStack(alignment: .leading, spacing: 6) {
                            Text("Days").font(.subheadline)
                            WeekdayPicker(selection: $workDays)
                        }
                        Stepper(commuteMin == 0 ? "Commute: none" : "Commute: \(commuteMin) min each way",
                                value: $commuteMin, in: 0...120, step: 5)
                    }
                }

                Section("Sleep") {
                    DatePicker("Bedtime", selection: $bedtime, displayedComponents: .hourAndMinute)
                    DatePicker("Wake up", selection: $wake, displayedComponents: .hourAndMinute)
                }

                Section {
                    mealRow("Breakfast", isOn: $hasBreakfast, time: $breakfast)
                    mealRow("Lunch", isOn: $hasLunch, time: $lunch)
                    mealRow("Dinner", isOn: $hasDinner, time: $dinner)
                } header: {
                    Text("Meals")
                } footer: {
                    Text("I'll keep these free so nothing gets scheduled over a meal.")
                }

                Section {
                    TextField("Home address", text: $homeAddress, axis: .vertical).lineLimit(1...2)
                    TextField("Work address (optional)", text: $workAddress, axis: .vertical).lineLimit(1...2)
                } header: {
                    Text("Where you're based")
                } footer: {
                    Text("Optional — lets me estimate real travel time to places you plan. You can add it later in your profile.")
                }

                if let error { Section { Text(error).foregroundStyle(.red).font(.footnote) } }

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

    @ViewBuilder
    private func mealRow(_ name: String, isOn: Binding<Bool>, time: Binding<Date>) -> some View {
        Toggle(name, isOn: isOn.animation())
        if isOn.wrappedValue {
            DatePicker("\(name) time", selection: time, displayedComponents: .hourAndMinute)
                .font(.callout)
        }
    }

    private func finish() {
        saving = true; error = nil
        Task {
            guard let uid = supa.userId?.uuidString else { saving = false; return }
            let everyDay = [0, 1, 2, 3, 4, 5, 6]
            var r: [RoutineInsert] = [
                RoutineInsert(user_id: uid, label: "Sleep", kind: "sleep", days_of_week: everyDay,
                              start_time: hhmmss(bedtime), end_time: hhmmss(wake), is_flexible: false),
            ]
            if hasWork && !workDays.isEmpty {
                let days = workDays.sorted()
                r.append(RoutineInsert(user_id: uid, label: "Work", kind: "work", days_of_week: days,
                                       start_time: hhmmss(workStart), end_time: hhmmss(workEnd), is_flexible: false))
                if commuteMin > 0 {
                    r.append(RoutineInsert(user_id: uid, label: "Commute to work", kind: "commute", days_of_week: days,
                                           start_time: hhmmss(workStart.addingMinutes(-commuteMin)), end_time: hhmmss(workStart), is_flexible: false))
                    r.append(RoutineInsert(user_id: uid, label: "Commute home", kind: "commute", days_of_week: days,
                                           start_time: hhmmss(workEnd), end_time: hhmmss(workEnd.addingMinutes(commuteMin)), is_flexible: false))
                }
            }
            if hasBreakfast { r.append(meal("Breakfast", breakfast, 30, uid)) }
            if hasLunch { r.append(meal("Lunch", lunch, 45, uid)) }
            if hasDinner { r.append(meal("Dinner", dinner, 60, uid)) }

            do {
                try? await supa.setTimezone(TimeZone.current.identifier)
                try await supa.saveRoutines(r)
                try? await supa.saveHomeWork(home: homeAddress, work: workAddress)   // best-effort
                await NotificationManager.shared.ensureAuthorization()
                supa.needsOnboarding = false
            } catch {
                self.error = error.localizedDescription
                saving = false
            }
        }
    }

    private func meal(_ name: String, _ start: Date, _ minutes: Int, _ uid: String) -> RoutineInsert {
        RoutineInsert(user_id: uid, label: name, kind: "meal", days_of_week: [0, 1, 2, 3, 4, 5, 6],
                      start_time: hhmmss(start), end_time: hhmmss(start.addingMinutes(minutes)), is_flexible: false)
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
    }
}

private func clock(_ h: Int, _ m: Int) -> Date {
    Calendar.current.date(bySettingHour: h, minute: m, second: 0, of: Date()) ?? Date()
}

private func hhmmss(_ d: Date) -> String {
    let c = Calendar.current.dateComponents([.hour, .minute], from: d)
    return String(format: "%02d:%02d:00", c.hour ?? 0, c.minute ?? 0)
}

private extension Date {
    func addingMinutes(_ m: Int) -> Date { addingTimeInterval(Double(m) * 60) }
}
