import SwiftUI

/// First-run setup as a conversation: Planfect asks one thing at a time (work, sleep, meals,
/// places) with tappable answers, then saves the routine. Deterministic + offline — no LLM call.
/// All copy is localized (English base + zh-Hans), so it follows the device language.
struct OnboardingView: View {
    @EnvironmentObject var supa: SupabaseManager

    private enum Step { case work, workHours, sleep, meals, places, done }
    private struct Msg: Identifiable { let id = UUID(); let bot: Bool; let text: String }

    @State private var step: Step = .work
    @State private var msgs: [Msg] = []
    @State private var saveFailed = false

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

    var body: some View {
        VStack(spacing: 0) {
            ScrollViewReader { proxy in
                ScrollView {
                    VStack(alignment: .leading, spacing: 14) {
                        ForEach(msgs) { bubble($0) }
                        Color.clear.frame(height: 1).id("end")
                    }
                    .padding()
                }
                .onChange(of: msgs.count) { _, _ in withAnimation { proxy.scrollTo("end", anchor: .bottom) } }
            }
            Divider()
            inputArea
                .padding(.horizontal).padding(.top, 10).padding(.bottom, 12)
                .background(.bar)
        }
        .fontDesign(.rounded)
        .onAppear { if msgs.isEmpty { start() } }
    }

    // MARK: - Conversation

    private func start() {
        botSay(String(localized: "Hi, I'm Planfect 👋"))
        botSay(String(localized: "Let's take a minute to learn your routine — then when I plan things for you, I'll work around these times automatically."))
        ask(.work)
    }

    private func botSay(_ t: String) { msgs.append(.init(bot: true, text: t)) }
    private func mySay(_ t: String) { msgs.append(.init(bot: false, text: t)) }

    private func ask(_ s: Step) {
        step = s
        switch s {
        case .work: botSay(String(localized: "Do you have set work / school hours?"))
        case .workHours: botSay(String(localized: "What hours? Pick the days they apply to 👇"))
        case .sleep: botSay(String(localized: "When do you usually sleep and wake up?"))
        case .meals: botSay(String(localized: "Around when are your meals? Turn off any you skip."))
        case .places: botSay(String(localized: "Last one — where do you live and work? Used to estimate travel time (optional)."))
        case .done: break
        }
    }

    private func finishFlow() {
        step = .done
        botSay(String(localized: "All set 🎉 Got it all — let's get you started!"))
        Task { await save() }
    }

    private func save() async {
        guard let uid = supa.userId?.uuidString else { return }
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
            try? await supa.saveHomeWork(home: homeAddress, work: workAddress)
            await NotificationManager.shared.ensureAuthorization()
            // Keep the setup conversation as chat history + leave a how-to as the first chat message.
            if let uid = supa.userId {
                ChatViewModel.seedFromOnboarding(msgs.map { (bot: $0.bot, text: $0.text) }, userId: uid)
            }
            supa.needsOnboarding = false
        } catch {
            saveFailed = true
            botSay(String(format: String(localized: "Hmm, couldn't save: %@. Tap Retry?"), error.localizedDescription))
        }
    }

    // MARK: - Input area (changes per step)

    @ViewBuilder private var inputArea: some View {
        switch step {
        case .work:
            HStack(spacing: 10) {
                chip(String(localized: "Set hours")) { hasWork = true; mySay(String(localized: "I have set work / school hours")); ask(.workHours) }
                chip(String(localized: "None / flexible")) { hasWork = false; mySay(String(localized: "No, my time is flexible")); ask(.sleep) }
            }
        case .workHours:
            VStack(spacing: 12) {
                timeRow(String(localized: "Start"), $workStart)
                timeRow(String(localized: "End"), $workEnd)
                WeekdayPicker(selection: $workDays)
                Stepper(commuteMin == 0 ? String(localized: "Commute: none")
                                        : String(format: String(localized: "Commute: %d min each way"), commuteMin),
                        value: $commuteMin, in: 0...120, step: 5).font(.subheadline)
                confirm(String(localized: "That's it")) { mySay(workSummary); ask(.sleep) }
            }
        case .sleep:
            VStack(spacing: 12) {
                timeRow(String(localized: "Sleep"), $bedtime)
                timeRow(String(localized: "Wake"), $wake)
                confirm(String(localized: "OK")) { mySay(String(format: String(localized: "Sleep %1$@, wake %2$@"), hhmm(bedtime), hhmm(wake))); ask(.meals) }
            }
        case .meals:
            VStack(spacing: 10) {
                mealRow(String(localized: "Breakfast"), $hasBreakfast, $breakfast)
                mealRow(String(localized: "Lunch"), $hasLunch, $lunch)
                mealRow(String(localized: "Dinner"), $hasDinner, $dinner)
                confirm(String(localized: "OK")) { mySay(mealSummary); ask(.places) }
            }
        case .places:
            VStack(spacing: 10) {
                AddressAutocompleteField(placeholder: String(localized: "Home address"), text: $homeAddress)
                AddressAutocompleteField(placeholder: String(localized: "Work / school (optional)"), text: $workAddress)
                HStack(spacing: 10) {
                    chip(String(localized: "Skip for now")) { mySay(String(localized: "Skip address for now")); finishFlow() }
                    confirm(String(localized: "Finish setup")) { mySay(placeSummary); finishFlow() }
                }
            }
        case .done:
            if saveFailed {
                confirm(String(localized: "Retry")) { saveFailed = false; Task { await save() } }
            } else {
                HStack(spacing: 8) { ProgressView(); Text("Setting things up…").foregroundStyle(.secondary).font(.subheadline) }
                    .frame(maxWidth: .infinity)
            }
        }
    }

    // MARK: - Summaries (shown as the user's reply bubble)

    private var workSummary: String {
        var s = String(format: String(localized: "Work %1$@–%2$@, %3$@"), hhmm(workStart), hhmm(workEnd), daysLabel(workDays))
        if commuteMin > 0 { s += String(format: String(localized: ", %d-min commute"), commuteMin) }
        return s
    }
    private var mealSummary: String {
        var parts: [String] = []
        if hasBreakfast { parts.append(String(format: String(localized: "breakfast %@"), hhmm(breakfast))) }
        if hasLunch { parts.append(String(format: String(localized: "lunch %@"), hhmm(lunch))) }
        if hasDinner { parts.append(String(format: String(localized: "dinner %@"), hhmm(dinner))) }
        return parts.isEmpty ? String(localized: "No set meal times") : parts.joined(separator: " · ")
    }
    private var placeSummary: String {
        var parts: [String] = []
        if !homeAddress.trimmingCharacters(in: .whitespaces).isEmpty { parts.append(String(format: String(localized: "Home: %@"), homeAddress)) }
        if !workAddress.trimmingCharacters(in: .whitespaces).isEmpty { parts.append(String(format: String(localized: "Work: %@"), workAddress)) }
        return parts.isEmpty ? String(localized: "Skip address for now") : parts.joined(separator: " / ")
    }

    private func daysLabel(_ days: Set<Int>) -> String {
        let s = days.sorted()
        if s == [0, 1, 2, 3, 4, 5, 6] { return String(localized: "Every day") }
        if s == [1, 2, 3, 4, 5] { return String(localized: "Weekdays") }
        if s == [0, 6] { return String(localized: "Weekends") }
        let names = Calendar.current.shortStandaloneWeekdaySymbols   // localized, 0=Sun
        return s.map { names[$0] }.joined(separator: " ")
    }

    // MARK: - Small UI pieces

    private func chip(_ t: String, _ a: @escaping () -> Void) -> some View {
        Button(action: a) {
            Text(t).fontWeight(.medium).frame(maxWidth: .infinity).padding(.vertical, 13)
        }
        .background(Color(.secondarySystemBackground), in: Capsule())
        .overlay(Capsule().strokeBorder(Color.accentColor.opacity(0.35), lineWidth: 1))
        .foregroundStyle(.primary)
    }

    private func confirm(_ t: String, _ a: @escaping () -> Void) -> some View {
        Button(action: a) {
            Text(t).bold().frame(maxWidth: .infinity).padding(.vertical, 13)
        }
        .background(LinearGradient(colors: [.accentColor, .purple], startPoint: .leading, endPoint: .trailing), in: Capsule())
        .foregroundStyle(.white)
    }

    private func timeRow(_ l: String, _ b: Binding<Date>) -> some View {
        HStack {
            Text(l).font(.subheadline)
            Spacer()
            DatePicker("", selection: b, displayedComponents: .hourAndMinute).labelsHidden()
        }
    }

    @ViewBuilder private func mealRow(_ name: String, _ on: Binding<Bool>, _ time: Binding<Date>) -> some View {
        HStack {
            Toggle(isOn: on.animation()) { Text(name).font(.subheadline) }
                .toggleStyle(.button).buttonStyle(.bordered).tint(.accentColor)
            Spacer()
            if on.wrappedValue {
                DatePicker("", selection: time, displayedComponents: .hourAndMinute).labelsHidden()
            } else {
                Text("Skip").font(.caption).foregroundStyle(.secondary)
            }
        }
    }

    @ViewBuilder private func bubble(_ m: Msg) -> some View {
        if m.bot {
            HStack(alignment: .top, spacing: 8) {
                BotAvatar()
                Text(m.text).font(.system(.body, design: .rounded)).lineSpacing(3)
                    .padding(.horizontal, 14).padding(.vertical, 10)
                    .background(Color(.secondarySystemBackground),
                                in: .rect(topLeadingRadius: 20, bottomLeadingRadius: 7, bottomTrailingRadius: 20, topTrailingRadius: 20))
                Spacer(minLength: 36)
            }
        } else {
            HStack {
                Spacer(minLength: 36)
                Text(m.text).font(.system(.body, design: .rounded))
                    .padding(.horizontal, 14).padding(.vertical, 10)
                    .foregroundStyle(.white)
                    .background(LinearGradient(colors: [.accentColor, .purple], startPoint: .topLeading, endPoint: .bottomTrailing),
                                in: .rect(topLeadingRadius: 20, bottomLeadingRadius: 20, bottomTrailingRadius: 7, topTrailingRadius: 20))
            }
        }
    }
}

private struct WeekdayPicker: View {
    @Binding var selection: Set<Int>
    private let labels = Calendar.current.veryShortStandaloneWeekdaySymbols   // localized, 0=Sun … 6=Sat

    var body: some View {
        HStack(spacing: 6) {
            ForEach(0..<7, id: \.self) { i in
                let on = selection.contains(i)
                Text(labels[i])
                    .font(.subheadline.bold())
                    .frame(maxWidth: .infinity).frame(height: 34)
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

private func hhmm(_ d: Date) -> String {
    let c = Calendar.current.dateComponents([.hour, .minute], from: d)
    return String(format: "%d:%02d", c.hour ?? 0, c.minute ?? 0)
}

private func meal(_ name: String, _ start: Date, _ minutes: Int, _ uid: String) -> RoutineInsert {
    RoutineInsert(user_id: uid, label: name, kind: "meal", days_of_week: [0, 1, 2, 3, 4, 5, 6],
                  start_time: hhmmss(start), end_time: hhmmss(start.addingMinutes(minutes)), is_flexible: false)
}

private extension Date {
    func addingMinutes(_ m: Int) -> Date { addingTimeInterval(Double(m) * 60) }
}
