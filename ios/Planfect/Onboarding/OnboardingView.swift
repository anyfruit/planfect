import SwiftUI

/// Conversational first-run setup: the bot asks a few tappable questions (same card UI as the
/// planner's clarifying questions) and turns the answers into the routine it plans around —
/// work/study hours, commute, and sleep. Anything else (gym, classes…) is added later via chat.
struct OnboardingView: View {
    @EnvironmentObject var supa: SupabaseManager

    @State private var step = 0
    @State private var work: WorkOption?
    @State private var commute: CommuteOption?
    @State private var sleep: SleepOption?
    @State private var saving = false
    @State private var error: String?

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    botBubble("👋 Hi, I'm Planfect. A few quick questions about your week so I can fit things around it — then just tell me what you need to do.")

                    if step >= 1, let work { answerBubble(work.label) }
                    if step == 0 { card(Self.workQuestion) { _, label in work = WorkOption.all.first { $0.label == label }; advance(to: 1) } }

                    if step >= 1 { botBubble("How long is your commute, one way?") }
                    if step >= 2, let commute { answerBubble(commute.label) }
                    if step == 1 { card(Self.commuteQuestion) { _, label in commute = CommuteOption.all.first { $0.label == label }; advance(to: 2) } }

                    if step >= 2 { botBubble("And when do you usually sleep?") }
                    if step >= 3, let sleep { answerBubble(sleep.label) }
                    if step == 2 { card(Self.sleepQuestion) { _, label in sleep = SleepOption.all.first { $0.label == label }; advance(to: 3) } }

                    if step >= 3 {
                        botBubble("Perfect — I'll plan around all that. Tell me anything else (gym, classes, recurring stuff) anytime in chat.")
                        if let error { Text(error).font(.footnote).foregroundStyle(.red) }
                        Button(action: finish) {
                            HStack { if saving { ProgressView() }; Text("Start planning").bold() }
                                .frame(maxWidth: .infinity).frame(height: 26)
                        }
                        .buttonStyle(.borderedProminent).disabled(saving).padding(.top, 4)
                    }
                }
                .padding()
            }
            .navigationTitle("Welcome").navigationBarTitleDisplayMode(.inline)
            .onAppear(perform: applyDebugStep)
        }
    }

    // A clarifying-style card for one onboarding question; calls back with the chosen label.
    private func card(_ q: PlanQuestion, onPick: @escaping (PlanQuestion, String) -> Void) -> some View {
        QuestionCardView(questions: [q]) { answers in
            if let label = answers.first?.selected.first { onPick(q, label) }
        }
    }

    private func advance(to next: Int) { withAnimation { step = next } }

    private func botBubble(_ text: String) -> some View {
        HStack {
            Text(text).padding(.horizontal, 14).padding(.vertical, 10)
                .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 18))
            Spacer(minLength: 40)
        }
    }

    private func answerBubble(_ text: String) -> some View {
        HStack {
            Spacer(minLength: 40)
            Text(text).padding(.horizontal, 14).padding(.vertical, 10)
                .background(Color.accentColor, in: RoundedRectangle(cornerRadius: 18))
                .foregroundStyle(.white)
        }
    }

    private func applyDebugStep() {
        #if DEBUG
        guard let s = ProcessInfo.processInfo.environment["PLANFECT_ONB_STEP"], let n = Int(s) else { return }
        if n >= 1 { work = WorkOption.all[0] }
        if n >= 2 { commute = CommuteOption.all[2] }
        if n >= 3 { sleep = SleepOption.all[0] }
        step = n
        #endif
    }

    private func finish() {
        saving = true; error = nil
        Task {
            guard let uid = supa.userId?.uuidString else { saving = false; return }
            var routines: [RoutineInsert] = []
            let s = sleep ?? SleepOption.all[0]
            routines.append(RoutineInsert(user_id: uid, label: "Sleep", kind: "sleep",
                                          days_of_week: [0, 1, 2, 3, 4, 5, 6],
                                          start_time: s.start, end_time: s.end, is_flexible: false))
            if let w = work, let h = w.hours {
                routines.append(RoutineInsert(user_id: uid, label: "Work", kind: "work",
                                              days_of_week: h.days, start_time: h.start, end_time: h.end, is_flexible: false))
                if let c = commute, c.minutes > 0 {
                    routines.append(RoutineInsert(user_id: uid, label: "Commute to work", kind: "commute",
                                                  days_of_week: h.days,
                                                  start_time: shift(h.start, -c.minutes), end_time: h.start, is_flexible: false))
                    routines.append(RoutineInsert(user_id: uid, label: "Commute home", kind: "commute",
                                                  days_of_week: h.days,
                                                  start_time: h.end, end_time: shift(h.end, c.minutes), is_flexible: false))
                }
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

    private func shift(_ hhmmss: String, _ delta: Int) -> String {
        let p = hhmmss.split(separator: ":").compactMap { Int($0) }
        guard p.count >= 2 else { return hhmmss }
        let total = max(0, min(24 * 60 - 1, p[0] * 60 + p[1] + delta))
        return String(format: "%02d:%02d:00", total / 60, total % 60)
    }

    // MARK: - Questions (built from the option tables; no fragile string matching elsewhere)

    static let workQuestion = PlanQuestion(
        id: "work", header: "Your week", question: "When do you usually work or study?",
        multi_select: false, options: WorkOption.all.map { PlanOption(label: $0.label, description: $0.desc) })

    static let commuteQuestion = PlanQuestion(
        id: "commute", header: "Commute", question: "How long is your commute, one way?",
        multi_select: false, options: CommuteOption.all.map { PlanOption(label: $0.label, description: $0.desc) })

    static let sleepQuestion = PlanQuestion(
        id: "sleep", header: "Sleep", question: "When do you usually sleep?",
        multi_select: false, options: SleepOption.all.map { PlanOption(label: $0.label, description: $0.desc) })
}

struct WorkOption {
    let label, desc: String
    let hours: (start: String, end: String, days: [Int])?
    static let all: [WorkOption] = [
        .init(label: "9–5, weekdays", desc: "Mon–Fri, 9 to 5", hours: ("09:00:00", "17:00:00", [1, 2, 3, 4, 5])),
        .init(label: "Evenings", desc: "Afternoons into the evening", hours: ("17:00:00", "21:00:00", [1, 2, 3, 4, 5])),
        .init(label: "Flexible / varies", desc: "No fixed hours to plan around", hours: nil),
        .init(label: "Not right now", desc: "No work or study block", hours: nil),
    ]
}

struct CommuteOption {
    let label, desc: String
    let minutes: Int
    static let all: [CommuteOption] = [
        .init(label: "Work from home / none", desc: "Nothing to block off", minutes: 0),
        .init(label: "About 15 minutes", desc: "Each way", minutes: 15),
        .init(label: "About 30 minutes", desc: "Each way", minutes: 30),
        .init(label: "About an hour", desc: "Each way", minutes: 60),
    ]
}

struct SleepOption {
    let label, desc, start, end: String
    static let all: [SleepOption] = [
        .init(label: "11 PM – 7 AM", desc: "A typical night", start: "23:00:00", end: "07:00:00"),
        .init(label: "Midnight – 8 AM", desc: "A bit later", start: "00:00:00", end: "08:00:00"),
        .init(label: "1 AM – 9 AM", desc: "Night owl", start: "01:00:00", end: "09:00:00"),
        .init(label: "10 PM – 6 AM", desc: "Early bird", start: "22:00:00", end: "06:00:00"),
    ]
}
