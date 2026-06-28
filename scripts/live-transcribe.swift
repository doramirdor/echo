import Foundation
import Speech
import AVFoundation

// Live microphone transcription using SFSpeechRecognizer
// Outputs partial results to stdout, one per line (prefixed with "partial:" or "final:")
// Stops when stdin is closed (parent process signals stop)

var finished = false
var audioEngine: AVAudioEngine?
var recognitionTask: SFSpeechRecognitionTask?

func startLiveRecognition() {
    SFSpeechRecognizer.requestAuthorization { status in
        guard status == .authorized else {
            FileHandle.standardError.write("Speech recognition not authorized.\n".data(using: .utf8)!)
            exit(1)
        }

        DispatchQueue.main.async {
            guard let recognizer = SFSpeechRecognizer(locale: Locale(identifier: "en-US")),
                  recognizer.isAvailable else {
                FileHandle.standardError.write("Speech recognizer not available.\n".data(using: .utf8)!)
                exit(1)
            }

            let engine = AVAudioEngine()
            audioEngine = engine
            let request = SFSpeechAudioBufferRecognitionRequest()
            request.shouldReportPartialResults = true

            recognitionTask = recognizer.recognitionTask(with: request) { result, error in
                if let result = result {
                    let text = result.bestTranscription.formattedString
                    if result.isFinal {
                        print("final:\(text)")
                    } else {
                        print("partial:\(text)")
                    }
                    fflush(stdout)
                }
                if error != nil {
                    // Don't exit on error — just stop gracefully
                    finished = true
                    CFRunLoopStop(CFRunLoopGetMain())
                }
            }

            let inputNode = engine.inputNode
            let recordingFormat = inputNode.outputFormat(forBus: 0)
            inputNode.installTap(onBus: 0, bufferSize: 1024, format: recordingFormat) { buffer, _ in
                request.append(buffer)
            }

            do {
                engine.prepare()
                try engine.start()
                FileHandle.standardError.write("live-transcribe: listening...\n".data(using: .utf8)!)
            } catch {
                FileHandle.standardError.write("Audio engine failed: \(error.localizedDescription)\n".data(using: .utf8)!)
                exit(1)
            }

            // Watch stdin in background — when parent closes stdin, we stop
            DispatchQueue.global().async {
                while let line = readLine() {
                    if line == "stop" {
                        break
                    }
                }
                DispatchQueue.main.async {
                    engine.stop()
                    inputNode.removeTap(onBus: 0)
                    request.endAudio()
                    // Give a moment for final result
                    DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) {
                        finished = true
                        CFRunLoopStop(CFRunLoopGetMain())
                    }
                }
            }
        }
    }
}

DispatchQueue.main.async {
    startLiveRecognition()
}

// Run for up to 5 minutes
let timeout = Date(timeIntervalSinceNow: 300)
while !finished && RunLoop.main.run(mode: .default, before: timeout) {
    // keep spinning
}
