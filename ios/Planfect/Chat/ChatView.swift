import SwiftUI
import UIKit

struct QuestionAnswer { let question: PlanQuestion; let selected: [String] }

struct ChatItem: Identifiable {
    let id = UUID()
    enum Role { case user, assistant }
    enum Content {
        case text(Role, String)
        case questions([PlanQuestion])
        case receipt(Receipt)
    }
    let content: Content

    static func user(_ s: String) -> ChatItem { .init(content: .text(.user, s)) }
    static func assistant(_ s: String) -> ChatItem { .init(content: .text(.assistant, s)) }
    static func questions(_ q: [PlanQuestion]) -> ChatItem { .init(content: .questions(q)) }
    static func receipt(_ r: Receipt) -> ChatItem { .init(content: .receipt(r)) }
}

@MainActor
final class ChatViewModel: ObservableObject {
    @Published var items: [ChatItem] = []
    @Published var input = ""
    @Published var sending = false
    @Published var showPaywall = false

    private var supa: SupabaseManager?
    private var history: [JSONValue] = []   // full LLM thread, sent every turn so context persists

    func bind(_ supa: SupabaseManager) {
        guard self.supa == nil else { return }
        self.supa = supa
        loadPersisted()
    }

    #if DEBUG
    private var seeded = false
    func seedIfRequested() {
        guard !seeded, let msg = ProcessInfo.processInfo.environment["PLANFECT_SEED_MESSAGE"] else { return }
        seeded = true
        input = msg
        send()
    }
    #endif

    func send() {
        let text = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, !sending else { return }
        input = ""
        items.append(.user(text))
        history.append(.object(["role": .string("user"), "content": .string(text)]))
        persist()
        Task { await run(PlanRequest(messages: history)) }
    }

    func answer(_ answers: [QuestionAnswer]) {
        guard !sending else { return }
        let summary = answers.flatMap(\.selected).joined(separator: ", ")
        items.append(.user(summary.isEmpty ? "(no selection)" : summary))
        guard let askId = JSONValue.askToolCallId(in: history) else {
            items.append(.assistant("Sorry — I lost the thread of that question. Mind rephrasing?"))
            return
        }
        let answerArray: [JSONValue] = answers.map { a in
            .object(["id": .string(a.question.id), "selected": .array(a.selected.map { .string($0) })])
        }
        let payload = JSONValue.object(["answers": .array(answerArray)]).jsonString()
        history.append(.object([
            "role": .string("tool"),
            "toolCallId": .string(askId),
            "content": .string(payload),
        ]))
        persist()
        Task { await run(PlanRequest(messages: history)) }
    }

    private func run(_ req: PlanRequest) async {
        guard let supa else { return }
        sending = true
        var req = req
        req.calendar_busy = await CalendarManager.shared.upcomingBusy()   // empty unless calendar sync is on
        do {
            let resp = try await supa.plan(req)
            if let m = resp.messages { history = m }
            switch resp.type {
            case "questions":
                if let qs = resp.questions, !qs.isEmpty { items.append(.questions(qs)) }
                else { items.append(.assistant("I had a question but it came through empty.")) }
            case "scheduled":
                if let r = resp.receipt {
                    items.append(.receipt(r))
                    await CalendarManager.shared.addPlans(r.items)   // mirror the plan into Apple Calendar (if synced)
                } else { items.append(.assistant("Scheduled.")) }
                // Refresh reminders so a just-scheduled plan nudges even if the user never opens Schedule.
                if let blocks = try? await supa.fetchBlocks() { await NotificationManager.shared.reschedule(for: blocks) }
            case "upgrade":
                items.append(.assistant(resp.text ?? "Upgrade to Planfect Pro to keep planning."))
                showPaywall = true
            default:
                items.append(.assistant(resp.text ?? "Done."))
            }
        } catch {
            // If the app was backgrounded mid-request the connection drops — but the planner often
            // finished server-side anyway. Pull the latest schedule so a plan that DID land shows up,
            // and say so honestly instead of a scary raw error.
            if let ue = error as? URLError,
               [.networkConnectionLost, .cancelled, .timedOut, .notConnectedToInternet].contains(ue.code) {
                if let blocks = try? await supa.fetchBlocks() { await NotificationManager.shared.reschedule(for: blocks) }
                items.append(.assistant("Sent — but the connection dropped when you switched away. I've refreshed; check Schedule to see if it landed, or resend."))
            } else {
                items.append(.assistant("⚠️ \(error.localizedDescription)"))
            }
        }
        persist()
        sending = false
    }

    // MARK: - Local persistence (so the transcript survives relaunch / view rebuilds)

    func clearPersisted() {
        items = []; history = []
        if let url = storageURL() { try? FileManager.default.removeItem(at: url) }
    }

    private func loadPersisted() {
        guard let url = storageURL(), let data = try? Data(contentsOf: url),
              let saved = try? JSONDecoder().decode(PersistedChat.self, from: data) else { return }
        history = saved.history
        items = saved.items.compactMap { $0.toChatItem() }
    }

    private func persist() {
        guard let url = storageURL() else { return }
        let payload = PersistedChat(history: history, items: items.map(PersistedItem.init))
        if let data = try? JSONEncoder().encode(payload) { try? data.write(to: url) }
    }

    /// Per-user file in Application Support so one account's chat never shows under another.
    private func storageURL() -> URL? {
        guard let uid = supa?.userId else { return nil }
        return Self.chatFileURL(uid)
    }

    static func chatFileURL(_ uid: UUID) -> URL? {
        guard let dir = try? FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true) else { return nil }
        return dir.appendingPathComponent("planfect-chat-\(uid.uuidString).json")
    }

    /// Seed the chat with the onboarding conversation + a short how-to, so the setup chat isn't lost
    /// and the user lands in Chat with guidance. Called once when onboarding finishes.
    static func seedFromOnboarding(_ lines: [(bot: Bool, text: String)], userId: UUID) {
        var chat = lines.map { ChatItem(content: .text($0.bot ? .assistant : .user, $0.text)) }
        let guide = [
            "全部记好啦 ✨ 接下来怎么用我:",
            "• 直接说要做的事就行——「明天下午去健身」「周五看牙」「这周写完报告」。我会排到合适的时间,并绕开你的作息。",
            "• 拿不准我会先问你一句,点选项确认就好。",
            "• 想看安排去下面的「Schedule」,想看时间花在哪了去「Insights」。",
            "• 作息、地址、提醒随时在右上角头像 ▸ Profile 里改。",
            "试试看:跟我说一件你接下来要做的事 👇",
        ].joined(separator: "\n")
        chat.append(ChatItem(content: .text(.assistant, guide)))
        let payload = PersistedChat(history: [], items: chat.map(PersistedItem.init))
        if let url = chatFileURL(userId), let data = try? JSONEncoder().encode(payload) {
            try? data.write(to: url)
        }
    }
}

/// Codable snapshot of the chat: the LLM thread plus a flattened view of the visible transcript.
private struct PersistedChat: Codable {
    var history: [JSONValue]
    var items: [PersistedItem]
}

private struct PersistedItem: Codable {
    var kind: String        // "text" | "questions" | "receipt"
    var role: String        // "user" | "assistant" (text only)
    var text: String?
    var questions: [PlanQuestion]?
    var receipt: Receipt?

    init(_ item: ChatItem) {
        switch item.content {
        case .text(let r, let s): kind = "text"; role = (r == .user ? "user" : "assistant"); text = s
        case .questions(let q): kind = "questions"; role = "assistant"; questions = q
        case .receipt(let r): kind = "receipt"; role = "assistant"; receipt = r
        }
    }

    func toChatItem() -> ChatItem? {
        switch kind {
        case "text": return ChatItem(content: .text(role == "user" ? .user : .assistant, text ?? ""))
        case "questions": return questions.map { ChatItem(content: .questions($0)) }
        case "receipt": return receipt.map { ChatItem(content: .receipt($0)) }
        default: return nil
        }
    }
}

struct ChatView: View {
    @EnvironmentObject var supa: SupabaseManager
    @StateObject private var vm = ChatViewModel()
    @StateObject private var speech = SpeechRecognizer()
    @FocusState private var inputFocused: Bool
    @Environment(\.openURL) private var openURL

    var body: some View {
        VStack(spacing: 0) {
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 14) {
                        if vm.items.isEmpty { EmptyChat() }
                        ForEach(vm.items) { item in
                            ChatRow(item: item, onAnswer: vm.answer)
                        }
                        if vm.sending {
                            HStack(alignment: .top, spacing: 8) {
                                BotAvatar()
                                HStack(spacing: 8) {
                                    ProgressView().controlSize(.small)
                                    Text("Planning…").foregroundStyle(.secondary).font(.system(.footnote, design: .rounded))
                                }
                                .padding(.horizontal, 14).padding(.vertical, 10)
                                .background(Color(.secondarySystemBackground), in: Capsule())
                            }
                        }
                        Color.clear.frame(height: 1).id("bottom")
                    }
                    .padding()
                }
                .onChange(of: vm.items.count) { _, _ in withAnimation { proxy.scrollTo("bottom", anchor: .bottom) } }
                .onChange(of: vm.sending) { _, _ in withAnimation { proxy.scrollTo("bottom", anchor: .bottom) } }
            }
            inputBar
        }
        .navigationTitle("Planfect")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .principal) {
                HStack(spacing: 5) {
                    Image(systemName: "sparkles").font(.footnote.weight(.bold))
                    Text("Planfect").font(.system(.headline, design: .rounded).weight(.heavy))
                }
                .foregroundStyle(LinearGradient(colors: [.accentColor, .purple], startPoint: .leading, endPoint: .trailing))
            }
        }
        .onAppear {
            vm.bind(supa)
            #if DEBUG
            vm.seedIfRequested()
            if ProcessInfo.processInfo.environment["PLANFECT_MIC_TEST"] == "1" {
                Task { try? await Task.sleep(nanoseconds: 1_500_000_000); speech.start() }
            }
            #endif
        }
        .onChange(of: speech.transcript) { _, t in if !t.isEmpty { vm.input = t } }
        .alert("Voice input", isPresented: Binding(
            get: { speech.errorMessage != nil },
            set: { if !$0 { speech.errorMessage = nil } }
        )) {
            Button("OK", role: .cancel) {}
            if let url = URL(string: UIApplication.openSettingsURLString) {
                Button("Open Settings") { openURL(url) }
            }
        } message: {
            Text(speech.errorMessage ?? "")
        }
        .sheet(isPresented: $vm.showPaywall) { PaywallView() }
    }

    private var inputBar: some View {
        let canSend = !vm.input.trimmingCharacters(in: .whitespaces).isEmpty && !vm.sending
        return HStack(spacing: 9) {
            HStack(spacing: 8) {
                Button { speech.toggle() } label: {
                    Image(systemName: speech.isRecording ? "stop.circle.fill" : "mic.fill")
                        .font(.system(size: 18))
                        .foregroundStyle(speech.isRecording ? Color.red : Color.secondary)
                        .symbolEffect(.bounce, value: speech.isRecording)
                }
                TextField("Tell me a plan…", text: $vm.input, axis: .vertical)
                    .textFieldStyle(.plain)
                    .lineLimit(1...4)
                    .focused($inputFocused)
            }
            .padding(.leading, 14).padding(.trailing, 12).padding(.vertical, 9)
            .background(Color(.secondarySystemBackground), in: Capsule())
            .overlay(Capsule().strokeBorder(Color.primary.opacity(0.06), lineWidth: 1))

            Button {
                inputFocused = false
                if speech.isRecording { speech.stop() }
                vm.send()
            } label: {
                Image(systemName: "arrow.up")
                    .font(.system(size: 17, weight: .bold))
                    .foregroundStyle(.white)
                    .frame(width: 38, height: 38)
                    .background(
                        canSend
                            ? AnyShapeStyle(LinearGradient(colors: [.accentColor, .purple], startPoint: .top, endPoint: .bottom))
                            : AnyShapeStyle(Color(.systemGray4)),
                        in: Circle()
                    )
            }
            .disabled(!canSend)
            .animation(.easeInOut(duration: 0.15), value: canSend)
        }
        .padding(.horizontal, 12).padding(.top, 8).padding(.bottom, 6)
        .background(.bar)
    }
}

private struct EmptyChat: View {
    var body: some View {
        VStack(spacing: 10) {
            Image(systemName: "sparkles").font(.largeTitle)
                .foregroundStyle(LinearGradient(colors: [.accentColor, .purple], startPoint: .top, endPoint: .bottom))
            Text("What's on your plate?").font(.system(.headline, design: .rounded).weight(.semibold))
            Text("“Dentist Friday afternoon, groceries this weekend, finish the report this week.”\nI'll fit it around your routine and travel time — and ask if I'm unsure.")
                .font(.subheadline).foregroundStyle(.secondary).multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity).padding(.top, 50).padding(.horizontal)
    }
}

private struct ChatRow: View {
    let item: ChatItem
    let onAnswer: ([QuestionAnswer]) -> Void

    var body: some View {
        switch item.content {
        case .text(.user, let s): Bubble(text: s, mine: true)
        case .text(.assistant, let s): withAvatar { Bubble(text: s, mine: false) }
        case .questions(let qs): withAvatar { QuestionCardView(questions: qs, onSubmit: onAnswer) }
        case .receipt(let r): withAvatar { ReceiptCardView(receipt: r) }
        }
    }

    @ViewBuilder private func withAvatar<V: View>(@ViewBuilder _ content: () -> V) -> some View {
        HStack(alignment: .top, spacing: 8) { BotAvatar(); content() }
    }
}

/// Planfect's little face — a friendly gradient mark next to everything the assistant says.
struct BotAvatar: View {
    var body: some View {
        Image(systemName: "sparkles")
            .font(.system(size: 14, weight: .bold))
            .foregroundStyle(.white)
            .frame(width: 30, height: 30)
            .background(
                LinearGradient(colors: [.accentColor, .purple],
                               startPoint: .topLeading, endPoint: .bottomTrailing),
                in: Circle()
            )
            .accessibilityHidden(true)
    }
}

private struct Bubble: View {
    let text: String
    let mine: Bool
    var body: some View {
        HStack {
            if mine { Spacer(minLength: 44) }
            Text(renderMarkdown(text))
                .font(.system(.body, design: .rounded))
                .lineSpacing(3.5)
                .tint(mine ? .white : .accentColor)   // links/inline accents legible on the gradient
                .padding(.horizontal, 15).padding(.vertical, 11)
                .foregroundStyle(mine ? .white : .primary)
                .background {
                    if mine {
                        LinearGradient(colors: [.accentColor, .purple],
                                       startPoint: .topLeading, endPoint: .bottomTrailing)
                    } else {
                        Color(.secondarySystemBackground)
                    }
                }
                .clipShape(.rect(topLeadingRadius: 20, bottomLeadingRadius: mine ? 20 : 7,
                                 bottomTrailingRadius: mine ? 7 : 20, topTrailingRadius: 20))
            if !mine { Spacer(minLength: 44) }
        }
    }

}

// Parse each message's markdown ONCE and cache it — a runtime String shows literal `**` otherwise,
// and re-parsing on every scroll frame is a real cost for a long transcript.
@MainActor private var markdownCache: [String: AttributedString] = [:]
@MainActor private func renderMarkdown(_ s: String) -> AttributedString {
    if let cached = markdownCache[s] { return cached }
    let a = (try? AttributedString(markdown: s, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)))
        ?? AttributedString(s)
    markdownCache[s] = a
    return a
}
