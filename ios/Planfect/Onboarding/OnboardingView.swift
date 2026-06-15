import SwiftUI

/// Conversational first-run setup: the bot asks a couple of tappable questions (same card UI as
/// the planner's clarifying questions) and turns the answers into the routine it plans around.
struct OnboardingView: View {
    @EnvironmentObject var supa: SupabaseManager

    @State private var step = 0
    @State private var work: WorkOption?
    @State private var sleep: SleepOption?
    @State private var saving = false
    @State private var error: String?

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    botBubble("👋 Hi, I'm Planfect. Tell me a few things about your week and I'll fit tasks around it — about 20 seconds.")

                    if step >= 1, let work { answerBubble(work.label) }
                    if step == 0 {
                        QuestionCardView(questions: [Self.workQuestion]) { answers in
                            work = WorkOption.all.first { $0.label == answers.first?.selected.first }
                            withAnimation { step = 1 }
                        }
                    }

                    if step >= 1 { botBubble("Got it. And when do you usually sleep?") }
                    if step >= 2, let sleep { answerBubble(sleep.label) }
                    if step == 1 {
                        QuestionCardView(questions: [Self.sleepQuestion]) { answers in
                            sleep = SleepOption.all.first { $0.label == answers.first?.selected.first }
                            withAnimation { step = 2 }
                        }
                    }

                    if step >= 2 {
                        botBubble("Perfect — I'll plan around that. You can fine-tune anytime in your profile.")
                        if let error { Text(error).font(.footnote).foregroundStyle(.red) }
                        Button(action: finish) {
                            HStack { if saving { ProgressView() }; Text("Start planning").bold() }
                                .frame(maxWidth: .infinity).frame(height: 26)
                        }
                        .buttonStyle(.borderedProminent)
                        .disabled(saving)
                        .padding(.top, 4)
                    }
                }
                .padding()
            }
            .navigationTitle("Welcome").navigationBarTitleDisplayMode(.inline)
        }
    }

    private func botBubble(_ text: String) -> some View {
        HStack {
            Text(text)
                .padding(.horizontal, 14).padding(.vertical, 10)
                .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 18))
            Spacer(minLength: 40)
        }
    }

    private func answerBubble(_ text: String) -> some View {
        HStack {
            Spacer(minLength: 40)
            Text(text)
                .padding(.horizontal, 14).padding(.vertical, 10)
                .background(Color.accentColor, in: RoundedRectangle(cornerRadius: 18))
                .foregroundStyle(.white)
        }
    }

    private func finish() {
        saving = true; error = nil
        Task {
            guard let uid = supa.userId?.uuidString else { saving = false; return }
            var routines: [RoutineInsert] = []
            let s = (sleep ?? SleepOption.all[0])
            routines.append(RoutineInsert(user_id: uid, label: "Sleep", kind: "sleep",
                                          days_of_week: [0, 1, 2, 3, 4, 5, 6],
                                          start_time: s.start, end_time: s.end, is_flexible: false))
            if let w = work, let h = w.hours {
                routines.append(RoutineInsert(user_id: uid, label: "Work", kind: "work",
                                              days_of_week: h.days, start_time: h.start, end_time: h.end, is_flexible: false))
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

    // MARK: - Options (label → routine values; no fragile string matching elsewhere)

    static let workQuestion = PlanQuestion(
        id: "work", header: "Your week",
        question: "When do you usually work or study?", multi_select: false,
        options: WorkOption.all.map { PlanOption(label: $0.label, description: $0.desc) })

    static let sleepQuestion = PlanQuestion(
        id: "sleep", header: "Sleep",
        question: "When do you usually sleep?", multi_select: false,
        options: SleepOption.all.map { PlanOption(label: $0.label, description: $0.desc) })
}

struct WorkOption {
    let label: String
    let desc: String
    let hours: (start: String, end: String, days: [Int])?

    static let all: [WorkOption] = [
        .init(label: "9–5, weekdays", desc: "Mon–Fri, 9 to 5", hours: ("09:00:00", "17:00:00", [1, 2, 3, 4, 5])),
        .init(label: "Evenings", desc: "Afternoons into the evening", hours: ("17:00:00", "21:00:00", [1, 2, 3, 4, 5])),
        .init(label: "Flexible / varies", desc: "No fixed hours to plan around", hours: nil),
        .init(label: "Not right now", desc: "No work or study block", hours: nil),
    ]
}

struct SleepOption {
    let label: String
    let desc: String
    let start: String
    let end: String

    static let all: [SleepOption] = [
        .init(label: "11 PM – 7 AM", desc: "A typical night", start: "23:00:00", end: "07:00:00"),
        .init(label: "Midnight – 8 AM", desc: "A bit later", start: "00:00:00", end: "08:00:00"),
        .init(label: "1 AM – 9 AM", desc: "Night owl", start: "01:00:00", end: "09:00:00"),
        .init(label: "10 PM – 6 AM", desc: "Early bird", start: "22:00:00", end: "06:00:00"),
    ]
}
