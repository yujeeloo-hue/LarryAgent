// macos-speech-transcriber — push-to-talk dictation helper for JellyBot.
//
// Streams the microphone into one SpeechAnalyzer with two SpeechTranscriber
// modules (zh_CN + en_US), picks the winning language by result confidence,
// and prints incremental events as JSON Lines on stdout:
//
//   {"type":"waiting","message":"…"}     model download / engine setup
//   {"type":"ready"}                     mic + engine live, levels incoming
//   {"type":"partial","text":"…","lang":"ZH"|"EN"}
//   {"type":"level","value":0.42}        mic peak 0...1, ~15 Hz
//   {"type":"final","text":"…","lang":"ZH"|"EN"}
//   {"type":"error","message":"…"}
//
// Lifecycle: the parent spawns the helper and holds the session open; closing
// the helper's stdin (EOF) requests a stop — audio is finalized, the winning
// language's accumulated text is emitted as `final`, and the process exits 0.
// SIGTERM/SIGINT follow the same path (close stdin -> graceful final).
//
// Engine verified on macOS 26.5 (ported from JNote's
// SpeechTranscriptionController, see JNote docs/plans/20260812-voice-dictation.md):
// - One analyzer per session; modules must NOT be reused across analyzers.
// - Volatile results grow cumulatively and may revise earlier text, so each
//   module's text is tracked as a whole and replaced wholesale, never appended.
// - Locale identifiers use underscores (zh_CN / en_US).

import AppKit
import AVFoundation
import Foundation
import Speech

// MARK: - Event protocol

private struct HelperEvent: Encodable {
    let type: String
    var message: String?
    var text: String?
    var lang: String?
    var value: Double?
}

/// stdout is line-buffered, one JSON object per line, serialized across the
/// result tasks / level timer / main task with a lock.
private let emitLock = NSLock()

private func emit(_ event: HelperEvent) {
    let encoder = JSONEncoder()
    guard let data = try? encoder.encode(event),
        let line = String(data: data, encoding: .utf8) else {
        return
    }
    emitLock.lock()
    FileHandle.standardOutput.write(Data((line + "\n").utf8))
    emitLock.unlock()
}

private func emitErrorAndExit(_ message: String) -> Never {
    emit(HelperEvent(type: "error", message: message, text: nil, lang: nil, value: nil))
    Foundation.exit(1)
}

// MARK: - Shared state

/// Mic peak since the last timer tick. Written from the realtime audio tap,
/// read + reset ~15 Hz from the level timer — a plain Float box is safe here.
private final class LevelBox: @unchecked Sendable {
    var value: Float = 0
}

/// Winning-language arbitration + cumulative text per module (JNote parity).
private final class TranscriberState: @unchecked Sendable {
    private let lock = NSLock()
    private var texts: [String: String] = [:]
    private var emas: [String: Double] = [:]
    private var language = "ZH"

    func record(text: String, confidence: Double?, for lang: String) {
        lock.lock()
        defer { lock.unlock() }
        texts[lang] = text
        if let confidence {
            let previous = emas[lang] ?? 0
            emas[lang] = previous == 0 ? confidence : previous * 0.8 + confidence * 0.2
        }
    }

    /// Hysteresis margin 0.08, same as JNote.
    func winningLanguage() -> String {
        lock.lock()
        defer { lock.unlock() }
        let zh = emas["ZH"] ?? 0
        let en = emas["EN"] ?? 0
        if zh - en >= 0.08 { return "ZH" }
        if en - zh >= 0.08 { return "EN" }
        return language
    }

    func text(for lang: String) -> String {
        lock.lock()
        defer { lock.unlock() }
        return texts[lang] ?? ""
    }
}

/// Bridges the stdin-EOF reader thread back into the async session task.
private final class StopContinuationBox: @unchecked Sendable {
    private let lock = NSLock()
    private var continuation: CheckedContinuation<Void, Never>?
    private var resumed = false

    func store(_ continuation: CheckedContinuation<Void, Never>) {
        lock.lock()
        defer { lock.unlock() }
        guard !resumed else {
            continuation.resume()
            return
        }
        self.continuation = continuation
    }

    func resume() {
        lock.lock()
        defer { lock.unlock() }
        guard !resumed else { return }
        resumed = true
        continuation?.resume()
        continuation = nil
    }
}

// MARK: - Entry

/// Tiny atomic flag (task thread sets, main thread polls).
final class FinishedFlag: @unchecked Sendable {
    private let lock = NSLock()
    private var value = false
    func set() {
        lock.lock()
        value = true
        lock.unlock()
    }
    var isSet: Bool {
        lock.lock()
        defer { lock.unlock() }
        return value
    }
}

@main
private enum SpeechTranscriberHelper {
    /// Run an async body while servicing the main run loop until it returns.
    /// Speech / AssetInventory XPC completions (locale reserve, transcriber
    /// init, format negotiation) are delivered via the main queue — blocking
    /// the main thread on a semaphore deadlocks the pipeline with zero
    /// events. The tick-and-check loop avoids the CFRunLoopStop race when
    /// the body finishes before run() is entered.
    private static func serveMainLoop(_ body: @escaping @Sendable () async -> Void) {
        let finished = FinishedFlag()
        Task {
            await body()
            finished.set()
            CFRunLoopStop(RunLoop.main.getCFRunLoop())
        }
        while !finished.isSet {
            RunLoop.main.run(mode: .default, before: Date(timeIntervalSinceNow: 0.5))
        }
    }

    static func main() {
        // CLI helpers that touch CoreAudio must create NSApplication first
        // (same lesson as macos-window-capture).
        let nsApp = NSApplication.shared
        nsApp.setActivationPolicy(.accessory)

        // macOS 26 SpeechAnalyzer gate (compile target matches).
        guard #available(macOS 26.0, *) else {
            emitErrorAndExit("Voice dictation requires macOS 26 or later.")
        }

        // SIGTERM/SIGINT -> close stdin, which unblocks the EOF reader and
        // stops the session the same way a normal speech:stop does.
        installSignalStop()

        // Diagnostics mode: run the engine init sequence with checkpoints
        // and exit — validates the pipeline without audio hardware.
        if ProcessInfo.processInfo.environment["SPEECH_HELPER_SELFTEST"] == "1" {
            serveMainLoop { await runEngineSelfTest() }
            Foundation.exit(0)
        }

        // Microphone permission is normally granted via the parent app's
        // systemPreferences.askForMediaAccess before spawn; the check below
        // is a fallback for unusual contexts. requestAccess delivers its
        // completion on the main queue, so the main thread must keep
        // servicing the run loop while waiting — a semaphore block would
        // hang forever in this CLI context.
        guard requestMicPermission() else {
            emitErrorAndExit(
                "Microphone access is required for voice input. Enable it in System Settings → Privacy & Security → Microphone."
            )
        }

        let stopBox = StopContinuationBox()
        serveMainLoop { await runSession(stopBox: stopBox) }
        Foundation.exit(0)
    }

    /// Dispatch-signal sources are async-safe; the handler closes stdin so the
    /// blocking reader in the session task observes EOF.
    private static func installSignalStop() {
        for sig in [SIGTERM, SIGINT] {
            signal(sig, SIG_IGN)
            let source = DispatchSource.makeSignalSource(signal: sig, queue: DispatchQueue.global(qos: .userInitiated))
            source.setEventHandler {
                close(FileHandle.standardInput.fileDescriptor)
                // During engine setup nothing reads stdin yet, so the EOF can
                // go unobserved; make SIGTERM terminal within the parent's
                // escalation window regardless.
                DispatchQueue.global().asyncAfter(deadline: .now() + 0.6) {
                    Foundation.exit(0)
                }
            }
            source.resume()
        }
    }

    /// Requests microphone access. The requestAccess completion lands on the
    /// main queue, so the main thread must keep servicing its run loop while
    /// the TCC prompt is up — blocking on a semaphore would deadlock the CLI.
    /// Already-granted sessions take a synchronous fast path.
    private static func requestMicPermission() -> Bool {
        switch AVCaptureDevice.authorizationStatus(for: .audio) {
        case .authorized:
            return true
        case .notDetermined:
            // While the TCC prompt (if any) is up, tell the parent so the UI
            // can show a waiting state instead of a silent mic button.
            emit(HelperEvent(type: "waiting", message: "Waiting for microphone permission…", text: nil, lang: nil, value: nil))
            var granted = false
            var answered = false
            AVCaptureDevice.requestAccess(for: .audio) { ok in
                granted = ok
                answered = true
            }
            // Upper bound covers a dismissed/ignored system prompt.
            let deadline = Date().addingTimeInterval(120)
            while !answered && Date() < deadline {
                _ = RunLoop.main.run(mode: .default, before: Date(timeIntervalSinceNow: 0.05))
            }
            return granted
        default:
            // Denied or restricted by MDM — no prompt possible.
            return false
        }
    }

    /// Consumes stdin until EOF (parent closed the pipe). Blocking POSIX read
    /// on a background thread; also released by fd-close from signal handlers.
    private static func readStdinUntilEOF() {
        let fd = FileHandle.standardInput.fileDescriptor
        let bufferSize = 4096
        let buffer = UnsafeMutablePointer<UInt8>.allocate(capacity: bufferSize)
        defer { buffer.deallocate() }
        while true {
            let n = read(fd, buffer, bufferSize)
            if n <= 0 { return }
        }
    }

    // MARK: - Session

    /// SPEECH_HELPER_SELFTEST checkpoint pass — mirrors runSession's engine
    /// init sequence without touching audio hardware or permissions.
    @available(macOS 26.0, *)
    private static func runEngineSelfTest() async {
        func step(_ label: String) {
            emit(HelperEvent(type: "waiting", message: "selftest: \(label)", text: nil, lang: nil, value: nil))
        }
        step("start")
        step("reserve zh_CN…")
        _ = try? await AssetInventory.reserve(locale: Locale(identifier: "zh_CN"))
        step("reserve en_US…")
        _ = try? await AssetInventory.reserve(locale: Locale(identifier: "en_US"))
        step("create transcribers…")
        let zh = SpeechTranscriber(
            locale: Locale(identifier: "zh_CN"),
            transcriptionOptions: [],
            reportingOptions: [.volatileResults, .fastResults],
            attributeOptions: [.transcriptionConfidence]
        )
        let en = SpeechTranscriber(
            locale: Locale(identifier: "en_US"),
            transcriptionOptions: [],
            reportingOptions: [.volatileResults, .fastResults],
            attributeOptions: [.transcriptionConfidence]
        )
        step("asset status…")
        let status = await AssetInventory.status(forModules: [zh, en])
        step("status=\(String(describing: status))")
        step("negotiate format…")
        let native = AVAudioFormat(standardFormatWithSampleRate: 48_000, channels: 1)
        let best = await SpeechAnalyzer.bestAvailableAudioFormat(
            compatibleWith: [zh, en], considering: native)
        step("best=\(best.map { String(Int($0.sampleRate)) } ?? "nil")")
        step("done")
    }

    @available(macOS 26.0, *)
    private static func runSession(stopBox: StopContinuationBox) async {
        // Engine setup (XPC + model checks) can take a moment on first use;
        // surface it before the first await so the UI never sits silent.
        emit(HelperEvent(type: "waiting", message: "Preparing speech engine…", text: nil, lang: nil, value: nil))

        // 1. Reserve the locales we use (two of the five allowed slots).
        _ = try? await AssetInventory.reserve(locale: Locale(identifier: "zh_CN"))
        _ = try? await AssetInventory.reserve(locale: Locale(identifier: "en_US"))

        // 2. Fresh modules per session (reusing across analyzers crashes).
        let zhModule = SpeechTranscriber(
            locale: Locale(identifier: "zh_CN"),
            transcriptionOptions: [],
            reportingOptions: [.volatileResults, .fastResults],
            attributeOptions: [.transcriptionConfidence]
        )
        let enModule = SpeechTranscriber(
            locale: Locale(identifier: "en_US"),
            transcriptionOptions: [],
            reportingOptions: [.volatileResults, .fastResults],
            attributeOptions: [.transcriptionConfidence]
        )

        // 3. Ensure the speech models are installed (first run downloads).
        let status = await AssetInventory.status(forModules: [zhModule, enModule])
        switch status {
        case .supported, .downloading:
            emit(HelperEvent(type: "waiting", message: "Downloading speech model…", text: nil, lang: nil, value: nil))
            guard let request = try? await AssetInventory.assetInstallationRequest(supporting: [zhModule, enModule]) else {
                emitErrorAndExit("Could not start a speech model download.")
            }
            do {
                try await request.downloadAndInstall()
            } catch {
                emitErrorAndExit("Speech model download failed: \(error.localizedDescription)")
            }
        case .unsupported:
            emitErrorAndExit("Speech transcription is not supported for Chinese or English on this Mac.")
        default:
            break
        }

        let state = TranscriberState()
        let levelBox = LevelBox()

        do {
            // 4. Audio format + analyzer.
            let engine = AVAudioEngine()
            let input = engine.inputNode
            let native = input.outputFormat(forBus: 0)
            guard native.sampleRate > 0, native.channelCount > 0 else {
                emitErrorAndExit("No microphone input is available on this Mac.")
            }
            guard let best = await SpeechAnalyzer.bestAvailableAudioFormat(
                compatibleWith: [zhModule, enModule], considering: native) else {
                emitErrorAndExit("No compatible audio format could be negotiated for speech transcription.")
            }
            guard let converter = AVAudioConverter(from: native, to: best) else {
                emitErrorAndExit("Could not create the audio format converter.")
            }
            let analyzer = SpeechAnalyzer(modules: [zhModule, enModule])
            try await analyzer.prepareToAnalyze(in: best)

            // 5. Mic tap -> convert -> analyzer input stream (+ peak level).
            let outCapacity = AVAudioFrameCount(best.sampleRate * 0.1)
            var streamContinuation: AsyncStream<AnalyzerInput>.Continuation?
            let stream = AsyncStream<AnalyzerInput> { continuation in
                streamContinuation = continuation
                input.installTap(onBus: 0, bufferSize: AVAudioFrameCount(native.sampleRate * 0.05), format: native) { buffer, _ in
                    guard let out = AVAudioPCMBuffer(pcmFormat: best, frameCapacity: outCapacity) else { return }
                    let status = converter.convert(to: out, error: nil) { _, outStatus in
                        outStatus.pointee = .haveData
                        return buffer
                    }
                    if status == .haveData, out.frameLength > 0 {
                        if let data = out.int16ChannelData?[0] {
                            let n = Int(out.frameLength)
                            var peak: Float = 0
                            for i in 0..<n {
                                let v = abs(Float(data[i]) / 32768.0)
                                if v > peak { peak = v }
                            }
                            if peak > levelBox.value { levelBox.value = peak }
                        }
                        continuation.yield(AnalyzerInput(buffer: out))
                    }
                }
            }
            guard let streamContinuation else {
                emitErrorAndExit("Could not start the microphone tap.")
            }

            // 6. Consume results from both modules (volatile + final).
            let resultTasks = [zhModule, enModule].map { module in
                Task {
                    do {
                        for try await result in module.results {
                            handleResult(result, lang: module === zhModule ? "ZH" : "EN", state: state)
                        }
                    } catch {}
                }
            }

            // 7. Drive the analyzer from the stream (no exit on completion —
            // the session ends via stdin EOF, not analyzer completion).
            let analysisTask = Task {
                do {
                    _ = try await analyzer.analyzeSequence(stream)
                } catch {}
            }

            // 8. Level timer: report the tap peak ~15 Hz (JNote polls 10 Hz;
            // a bit faster reads better for a compact waveform).
            let levelTimer = DispatchSource.makeTimerSource(queue: DispatchQueue.global(qos: .utility))
            levelTimer.schedule(deadline: .now() + .milliseconds(66), repeating: .milliseconds(66))
            levelTimer.setEventHandler {
                let peak = levelBox.value
                levelBox.value = 0
                emit(HelperEvent(type: "level", message: nil, text: nil, lang: nil, value: Double(peak)))
            }
            levelTimer.resume()

            engine.prepare()
            try engine.start()
            emit(HelperEvent(type: "ready", message: nil, text: nil, lang: nil, value: nil))

            // 9. Suspend until stdin closes (stop request) — signal handlers
            // close the same fd, covering SIGTERM/SIGINT identically.
            await withCheckedContinuation { continuation in
                stopBox.store(continuation)
                DispatchQueue.global(qos: .userInitiated).async {
                    readStdinUntilEOF()
                    stopBox.resume()
                }
            }

            // 10. Graceful teardown: stop audio, finalize, emit final.
            levelTimer.cancel()
            // Tail grace: hold-to-talk users release right at the last
            // syllable — keep the mic open briefly so it lands in the take.
            try? await Task.sleep(nanoseconds: 300_000_000)
            engine.stop()
            streamContinuation.finish()
            try? await analyzer.finalizeAndFinishThroughEndOfInput()
            // Cancel consumers only after finalize: their results streams
            // deliver the finalized transcript, cancelling early loses it.
            for task in resultTasks { task.cancel() }
            analysisTask.cancel()

            let winner = state.winningLanguage()
            let text = state.text(for: winner)
            emit(HelperEvent(type: "final", message: nil, text: text, lang: winner, value: nil))
        } catch {
            emitErrorAndExit("Speech transcription failed: \(error.localizedDescription)")
        }
    }

    @available(macOS 26.0, *)
    private static func handleResult(_ result: SpeechTranscriber.Result, lang: String, state: TranscriberState) {
        let text = String(result.text.characters)
        state.record(text: text, confidence: averageConfidence(result.text), for: lang)
        // Only surface the winning module's text as partial (whole-tail replace).
        if state.winningLanguage() == lang {
            emit(HelperEvent(type: "partial", message: nil, text: text, lang: lang, value: nil))
        }
    }

    @available(macOS 26.0, *)
    private static func averageConfidence(_ text: AttributedString) -> Double? {
        var total = 0.0
        var count = 0
        for run in text.runs {
            if let confidence = run.attributes[keyPath: \.transcriptionConfidence] {
                total += confidence
                count += 1
            }
        }
        guard count > 0 else { return nil }
        return total / Double(count)
    }
}
