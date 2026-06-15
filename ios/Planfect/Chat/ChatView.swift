import SwiftUI

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
        do {
            let resp = try await supa.plan(req)
            if let m = resp.messages { history = m }
            switch resp.type {
            case "questions":
                if let qs = resp.questions, !qs.isEmpty { items.append(.questions(qs)) }
                else { items.append(.assistant("I had a question but it came through empty.")) }
            case "scheduled":
                if let r = resp.receipt { items.append(.receipt(r)) } else { items.append(.assistant("Scheduled.")) }
                // Refresh reminders so a just-scheduled plan nudges even if the user never opens Schedule.
                if let blocks = try? await supa.fetchBlocks() { await NotificationManager.shared.reschedule(for: blocks) }
            default:
                items.append(.assistant(resp.text ?? "Done."))
            }
        } catch {
            items.append(.assistant("⚠️ \(error.localizedDescription)"))
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
        let fm = FileManager.default
        guard let dir = try? fm.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true) else { return nil }
        return dir.appendingPathComponent("planfect-chat-\(uid.uuidString).json")
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
                            HStack(spacing: 8) { ProgressView(); Text("Planning…").foregroundStyle(.secondary).font(.footnote) }
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
        .onAppear {
            vm.bind(supa)
            #if DEBUG
            vm.seedIfRequested()
            #endif
        }
        .onChange(of: speech.transcript) { _, t in if !t.isEmpty { vm.input = t } }
    }

    private var inputBar: some View {
        HStack(spacing: 10) {
            Button { speech.toggle() } label: {
                Image(systemName: speech.isRecording ? "stop.circle.fill" : "mic.fill")
                    .font(.title2).foregroundStyle(speech.isRecording ? Color.red : Color.accentColor)
            }
            TextField("Tell me a plan…", text: $vm.input, axis: .vertical)
                .lineLimit(1...4)
                .textFieldStyle(.roundedBorder)
                .focused($inputFocused)
            Button {
                inputFocused = false
                if speech.isRecording { speech.stop() }
                vm.send()
            } label: {
                Image(systemName: "arrow.up.circle.fill").font(.title)
            }
            .disabled(vm.input.trimmingCharacters(in: .whitespaces).isEmpty || vm.sending)
        }
        .padding(.horizontal).padding(.vertical, 8)
        .background(.bar)
    }
}

private struct EmptyChat: View {
    var body: some View {
        VStack(spacing: 10) {
            Image(systemName: "sparkles").font(.largeTitle).foregroundStyle(.tint)
            Text("What's on your plate?").font(.headline)
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
            if mine { Spacer(minLength: 40) }
            Text(text)
                .padding(.horizontal, 14).padding(.vertical, 10)
                .background(mine ? Color.accentColor : Color(.secondarySystemBackground),
                            in: RoundedRectangle(cornerRadius: 18))
                .foregroundStyle(mine ? Color.white : Color.primary)
            if !mine { Spacer(minLength: 40) }
        }
    }
}
