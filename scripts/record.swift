import Foundation
import AVFoundation

// Native microphone capture for Echo — replaces the external `sox`/`rec`
// dependency so the app runs with zero Homebrew installs.
//
// Captures the default input device and streams raw 16 kHz / mono / 16-bit
// little-endian PCM to stdout — byte-for-byte what `rec -r 16000 -c 1 -b 16
// -t raw -` produced. The parent process writes those bytes straight into a
// WAV file and computes level metering, exactly as before.
//
// Stops cleanly when the parent writes "stop\n" to stdin, closes stdin (EOF),
// or sends SIGTERM. All diagnostics go to stderr so stdout stays pure PCM.
//
// Note: an optional device-name argument is accepted for forward-compatibility
// but currently ignored — capture follows the system default input device.

let errOut = FileHandle.standardError
func logErr(_ s: String) { errOut.write((s + "\n").data(using: .utf8)!) }

let stdOut = FileHandle.standardOutput
let engine = AVAudioEngine()

if CommandLine.arguments.count > 1, !CommandLine.arguments[1].isEmpty {
    logErr("record: device \"\(CommandLine.arguments[1])\" requested; using system default input")
}

func startCapture() {
    let inputNode = engine.inputNode
    let inputFormat = inputNode.inputFormat(forBus: 0)

    guard inputFormat.sampleRate > 0 else {
        logErr("record: no audio input available")
        exit(1)
    }

    guard let targetFormat = AVAudioFormat(
        commonFormat: .pcmFormatInt16,
        sampleRate: 16000,
        channels: 1,
        interleaved: true
    ) else {
        logErr("record: failed to build target format")
        exit(1)
    }

    guard let converter = AVAudioConverter(from: inputFormat, to: targetFormat) else {
        logErr("record: failed to create audio converter")
        exit(1)
    }

    let ratio = targetFormat.sampleRate / inputFormat.sampleRate

    inputNode.installTap(onBus: 0, bufferSize: 4096, format: inputFormat) { buffer, _ in
        let capacity = AVAudioFrameCount(Double(buffer.frameLength) * ratio) + 64
        guard let outBuffer = AVAudioPCMBuffer(pcmFormat: targetFormat, frameCapacity: capacity) else { return }

        var consumed = false
        let inputBlock: AVAudioConverterInputBlock = { _, outStatus in
            if consumed {
                outStatus.pointee = .noDataNow
                return nil
            }
            consumed = true
            outStatus.pointee = .haveData
            return buffer
        }

        var convErr: NSError?
        let status = converter.convert(to: outBuffer, error: &convErr, withInputFrom: inputBlock)
        if status == .error { return }

        let frames = Int(outBuffer.frameLength)
        guard frames > 0, let channel = outBuffer.int16ChannelData else { return }
        stdOut.write(Data(bytes: channel[0], count: frames * MemoryLayout<Int16>.size))
    }

    do {
        engine.prepare()
        try engine.start()
        logErr("record: listening (\(Int(inputFormat.sampleRate))Hz \(inputFormat.channelCount)ch -> 16000Hz mono)")
    } catch {
        logErr("record: audio engine failed: \(error.localizedDescription)")
        exit(1)
    }
}

func stopCapture() {
    engine.inputNode.removeTap(onBus: 0)
    engine.stop()
}

// Microphone access — the prompt is attributed to the host app (Echo).
AVCaptureDevice.requestAccess(for: .audio) { granted in
    DispatchQueue.main.async {
        guard granted else {
            logErr("record: microphone access denied")
            exit(1)
        }
        startCapture()
    }
}

// Parent signals stop by writing "stop" or by closing stdin (readLine -> nil).
DispatchQueue.global().async {
    while let line = readLine() {
        if line == "stop" { break }
    }
    DispatchQueue.main.async {
        stopCapture()
        exit(0)
    }
}

// SIGTERM: stop the engine and exit promptly (streamed data is already flushed).
let sigtermSrc = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
sigtermSrc.setEventHandler {
    stopCapture()
    exit(0)
}
sigtermSrc.resume()
signal(SIGTERM, SIG_IGN)

RunLoop.main.run()
