import Foundation
import Speech
import AVFoundation

/// On-device speech-to-text for the mic button. Transcribes into `transcript`; the chat view
/// mirrors it into the input field. Requests BOTH speech-recognition and microphone permission,
/// and reports a reason via `errorMessage` instead of failing silently.
@MainActor
final class SpeechRecognizer: ObservableObject {
    @Published var transcript = ""
    @Published var isRecording = false
    @Published var errorMessage: String?

    // Default initializer follows the device's current locale, so a Chinese user gets Chinese STT.
    private let recognizer = SFSpeechRecognizer() ?? SFSpeechRecognizer(locale: Locale(identifier: "en-US"))
    private let engine = AVAudioEngine()
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?

    func toggle() { isRecording ? stop() : start() }

    func start() {
        errorMessage = nil
        // 1) Speech-recognition permission, then 2) microphone permission — both are required.
        SFSpeechRecognizer.requestAuthorization { speechStatus in
            Task { @MainActor in
                guard speechStatus == .authorized else {
                    self.errorMessage = "Speech Recognition is off for Planfect. Turn it on in Settings ▸ Planfect to use voice input."
                    return
                }
                AVAudioApplication.requestRecordPermission { micGranted in
                    Task { @MainActor in
                        guard micGranted else {
                            self.errorMessage = "Microphone access is off for Planfect. Turn it on in Settings ▸ Planfect to use voice input."
                            return
                        }
                        self.begin()
                    }
                }
            }
        }
    }

    private func begin() {
        guard let recognizer else { errorMessage = "Speech recognition isn't available on this device."; return }
        guard recognizer.isAvailable else { errorMessage = "Speech recognition is temporarily unavailable — check your connection."; return }
        guard !isRecording else { return }
        do {
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.record, mode: .measurement, options: .duckOthers)
            try session.setActive(true, options: .notifyOthersOnDeactivation)

            // A valid input format requires a working mic — absent on most simulators.
            let input = engine.inputNode
            let format = input.outputFormat(forBus: 0)
            guard format.sampleRate > 0, format.channelCount > 0 else {
                errorMessage = "No microphone available. Voice input needs a real device (the Simulator's mic usually doesn't work)."
                deactivateSession()
                return
            }

            let request = SFSpeechAudioBufferRecognitionRequest()
            request.shouldReportPartialResults = true
            self.request = request

            input.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in
                request.append(buffer)
            }
            engine.prepare()
            try engine.start()

            transcript = ""
            isRecording = true
            task = recognizer.recognitionTask(with: request) { [weak self] result, error in
                Task { @MainActor in
                    guard let self else { return }
                    if let result { self.transcript = result.bestTranscription.formattedString }
                    if error != nil || (result?.isFinal ?? false) { self.stop() }
                }
            }
        } catch {
            errorMessage = "Couldn't start recording: \(error.localizedDescription)"
            stop()
        }
    }

    func stop() {
        if engine.isRunning {
            engine.stop()
            engine.inputNode.removeTap(onBus: 0)
        }
        request?.endAudio()
        task?.cancel()
        request = nil
        task = nil
        isRecording = false
        deactivateSession()
    }

    private func deactivateSession() {
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }
}
