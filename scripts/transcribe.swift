import Foundation
import Speech

guard CommandLine.arguments.count > 1 else {
    FileHandle.standardError.write("Usage: transcribe <path-to-wav>\n".data(using: .utf8)!)
    exit(1)
}

let filePath = CommandLine.arguments[1]
let fileURL = URL(fileURLWithPath: filePath)

guard FileManager.default.fileExists(atPath: filePath) else {
    FileHandle.standardError.write("File not found: \(filePath)\n".data(using: .utf8)!)
    exit(1)
}

var finished = false

func doRecognition() {
    SFSpeechRecognizer.requestAuthorization { status in
        guard status == .authorized else {
            FileHandle.standardError.write("Speech recognition not authorized. Go to System Settings > Privacy & Security > Speech Recognition.\n".data(using: .utf8)!)
            exit(1)
        }

        guard let recognizer = SFSpeechRecognizer(locale: Locale(identifier: "en-US")),
              recognizer.isAvailable else {
            FileHandle.standardError.write("Speech recognizer not available.\n".data(using: .utf8)!)
            exit(1)
        }

        let request = SFSpeechURLRecognitionRequest(url: fileURL)
        request.shouldReportPartialResults = false

        recognizer.recognitionTask(with: request) { result, error in
            if let error = error {
                FileHandle.standardError.write("Recognition error: \(error.localizedDescription)\n".data(using: .utf8)!)
                exit(1)
            }

            if let result = result, result.isFinal {
                print(result.bestTranscription.formattedString)
                finished = true
                CFRunLoopStop(CFRunLoopGetMain())
            }
        }
    }
}

// Kick off on the main queue
DispatchQueue.main.async {
    doRecognition()
}

// Run the main RunLoop so callbacks can fire
// Timeout after 25 seconds
let timeout = Date(timeIntervalSinceNow: 25)
while !finished && RunLoop.main.run(mode: .default, before: timeout) {
    // keep spinning
}

if !finished {
    FileHandle.standardError.write("Timeout: recognition took too long.\n".data(using: .utf8)!)
    exit(1)
}
