import SwiftUI

/// First-run setup as a conversation: Planfect asks one thing at a time (work, sleep, meals,
/// places) with tappable answers, then saves the routine. Deterministic + offline — no LLM call.
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
        botSay("嗨,我是 Planfect 👋")
        botSay("先花一分钟了解下你的作息——之后我帮你安排事情,就会自动绕开这些时间。")
        ask(.work)
    }

    private func botSay(_ t: String) { msgs.append(.init(bot: true, text: t)) }
    private func mySay(_ t: String) { msgs.append(.init(bot: false, text: t)) }

    private func ask(_ s: Step) {
        step = s
        switch s {
        case .work: botSay("你平时有固定的上班 / 上学时间吗?")
        case .workHours: botSay("几点到几点?把适用的星期几选上 👇")
        case .sleep: botSay("一般几点睡、几点起?")
        case .meals: botSay("三餐大概几点吃?不吃的关掉就行。")
        case .places: botSay("最后~ 你住哪儿、在哪上班?用来算路上的通勤时间(可选)。")
        case .done: break
        }
    }

    private func finishFlow() {
        step = .done
        botSay("搞定 🎉 都记下了,带你开始用!")
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
            botSay("呃,没存上:\(error.localizedDescription)。点「重试」?")
        }
    }

    // MARK: - Input area (changes per step)

    @ViewBuilder private var inputArea: some View {
        switch step {
        case .work:
            HStack(spacing: 10) {
                chip("有固定时间") { hasWork = true; mySay("有固定的上班/上学时间"); ask(.workHours) }
                chip("没有 / 不固定") { hasWork = false; mySay("没有,时间不固定"); ask(.sleep) }
            }
        case .workHours:
            VStack(spacing: 12) {
                timeRow("开始", $workStart)
                timeRow("结束", $workEnd)
                WeekdayPicker(selection: $workDays)
                Stepper(commuteMin == 0 ? "通勤:无" : "通勤:单程 \(commuteMin) 分钟",
                        value: $commuteMin, in: 0...120, step: 5).font(.subheadline)
                confirm("就这些") { mySay(workSummary); ask(.sleep) }
            }
        case .sleep:
            VStack(spacing: 12) {
                timeRow("睡觉", $bedtime)
                timeRow("起床", $wake)
                confirm("确定") { mySay("\(hhmm(bedtime)) 睡,\(hhmm(wake)) 起"); ask(.meals) }
            }
        case .meals:
            VStack(spacing: 10) {
                mealRow("早餐", $hasBreakfast, $breakfast)
                mealRow("午餐", $hasLunch, $lunch)
                mealRow("晚餐", $hasDinner, $dinner)
                confirm("确定") { mySay(mealSummary); ask(.places) }
            }
        case .places:
            VStack(spacing: 10) {
                AddressAutocompleteField(placeholder: "家庭住址", text: $homeAddress)
                AddressAutocompleteField(placeholder: "公司 / 学校(可选)", text: $workAddress)
                HStack(spacing: 10) {
                    chip("先跳过") { mySay("地址先不填"); finishFlow() }
                    confirm("完成设定") { mySay(placeSummary); finishFlow() }
                }
            }
        case .done:
            if saveFailed {
                confirm("重试") { saveFailed = false; Task { await save() } }
            } else {
                HStack(spacing: 8) { ProgressView(); Text("正在为你布置…").foregroundStyle(.secondary).font(.subheadline) }
                    .frame(maxWidth: .infinity)
            }
        }
    }

    // MARK: - Summaries (shown as the user's reply bubble)

    private var workSummary: String {
        var s = "上班 \(hhmm(workStart))–\(hhmm(workEnd)),\(daysLabel(workDays))"
        if commuteMin > 0 { s += ",通勤 \(commuteMin) 分钟" }
        return s
    }
    private var mealSummary: String {
        var parts: [String] = []
        if hasBreakfast { parts.append("早 \(hhmm(breakfast))") }
        if hasLunch { parts.append("午 \(hhmm(lunch))") }
        if hasDinner { parts.append("晚 \(hhmm(dinner))") }
        return parts.isEmpty ? "不用特意留三餐时间" : parts.joined(separator: "、")
    }
    private var placeSummary: String {
        var parts: [String] = []
        if !homeAddress.trimmingCharacters(in: .whitespaces).isEmpty { parts.append("家:\(homeAddress)") }
        if !workAddress.trimmingCharacters(in: .whitespaces).isEmpty { parts.append("公司:\(workAddress)") }
        return parts.isEmpty ? "地址先不填" : parts.joined(separator: " / ")
    }

    private func daysLabel(_ days: Set<Int>) -> String {
        let s = days.sorted()
        if s == [0, 1, 2, 3, 4, 5, 6] { return "每天" }
        if s == [1, 2, 3, 4, 5] { return "工作日" }
        if s == [0, 6] { return "周末" }
        let names = ["日", "一", "二", "三", "四", "五", "六"]
        return "周" + s.map { names[$0] }.joined()
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
                Text("不吃").font(.caption).foregroundStyle(.secondary)
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
    private let labels = ["日", "一", "二", "三", "四", "五", "六"]   // 0=Sun … 6=Sat

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
