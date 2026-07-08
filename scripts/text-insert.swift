import Foundation
import AppKit
import CoreGraphics

// Echo text-insertion helper. Replaces the osascript / System Events path so the
// insertion pipeline needs only ACCESSIBILITY (to post synthetic keystrokes) and
// NO AUTOMATION (Apple Events). This matters because the dev binary
// (`target/debug/echo`, run by `cargo tauri dev`) has no bundled Info.plist, so
// macOS silently denies it Automation with no prompt — making osascript-based
// insertion impossible in development. CGEvent posting + AppKit activation avoid
// Apple Events entirely.
//
// One action per invocation (keeps the parent's call sites trivial):
//   text-insert ensure-ax        prompt for / check Accessibility; prints ax-granted|ax-denied
//   text-insert frontmost        print the frontmost app's name (NSWorkspace, no permission)
//   text-insert activate "<name>"  bring an app forward by name (NSWorkspace, no permission)
//   text-insert modifiers        print held modifier bits (NSEvent, no permission)
//   text-insert paste            post Cmd+V
//   text-insert replace <N>      post Shift+Left ×N, then Cmd+V
//   text-insert delete <N>       post Shift+Left ×N, then Delete (backspace)
//
// --- TCC responsibility disclaim (same rationale as fn-monitor.swift) ---
// Re-spawn ourselves disclaimed so macOS keys the Accessibility grant on THIS
// helper's own stable `com.echo.text-insert` cdhash instead of the volatile
// parent app (whose ad-hoc cdhash changes every rebuild). Granted once, it then
// survives rebuilds. Falls through to inline execution if the SPI ever fails.
@_silgen_name("responsibility_spawnattrs_setdisclaim")
func responsibility_spawnattrs_setdisclaim(
    _ attrs: UnsafeMutablePointer<posix_spawnattr_t?>, _ disclaim: Int32
) -> Int32

func relaunchDisclaimed() -> Bool {
    var attr: posix_spawnattr_t?
    guard posix_spawnattr_init(&attr) == 0 else { return false }
    defer { posix_spawnattr_destroy(&attr) }
    guard responsibility_spawnattrs_setdisclaim(&attr, 1) == 0 else { return false }
    let exePath = CommandLine.arguments[0]
    var argv: [UnsafeMutablePointer<CChar>?] = CommandLine.arguments.map { strdup($0) }
    argv.append(nil)
    var env: [UnsafeMutablePointer<CChar>?] = ProcessInfo.processInfo.environment.map {
        strdup("\($0.key)=\($0.value)")
    }
    env.append(strdup("ECHO_INSERT_DISCLAIMED=1"))
    env.append(nil)
    defer {
        for p in argv where p != nil { free(p) }
        for p in env where p != nil { free(p) }
    }
    var pid: pid_t = 0
    guard posix_spawn(&pid, exePath, nil, &attr, &argv, &env) == 0 else { return false }
    var status: Int32 = 0
    waitpid(pid, &status, 0)
    exit((status & 0x7f) == 0 ? (status >> 8) & 0xff : 1)
}

// Packaged builds set ECHO_NO_DISCLAIM=1 so the Accessibility grant binds to
// "Echo" instead of a separate `text-insert` row (see fn-monitor.swift). Dev
// leaves it unset and still disclaims to survive the parent's cdhash churn.
if ProcessInfo.processInfo.environment["ECHO_NO_DISCLAIM"] == nil,
   ProcessInfo.processInfo.environment["ECHO_INSERT_DISCLAIMED"] == nil {
    _ = relaunchDisclaimed()  // on success this exit()s; on failure we run inline
}

// --- key posting ---
let kV: CGKeyCode = 9      // kVK_ANSI_V
let kLeft: CGKeyCode = 123 // kVK_LeftArrow
let kDelete: CGKeyCode = 51 // kVK_Delete (backspace)

func postKey(_ code: CGKeyCode, flags: CGEventFlags) {
    let src = CGEventSource(stateID: .combinedSessionState)
    if let down = CGEvent(keyboardEventSource: src, virtualKey: code, keyDown: true) {
        down.flags = flags
        down.post(tap: .cghidEventTap)
    }
    if let up = CGEvent(keyboardEventSource: src, virtualKey: code, keyDown: false) {
        up.flags = flags
        up.post(tap: .cghidEventTap)
    }
    usleep(3_000)
}

let args = CommandLine.arguments
guard args.count >= 2 else {
    FileHandle.standardError.write("usage: text-insert <action> [arg]\n".data(using: .utf8)!)
    exit(2)
}

switch args[1] {
case "ensure-ax":
    // Prompt the user (once) and register this helper in System Settings →
    // Privacy & Security → Accessibility so the grant can be toggled on.
    let opts = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
    print(AXIsProcessTrustedWithOptions(opts) ? "ax-granted" : "ax-denied")

case "check-ax":
    // Non-prompting status check (for the permissions panel / refresh).
    print(AXIsProcessTrusted() ? "ax-granted" : "ax-denied")

case "frontmost":
    if let n = NSWorkspace.shared.frontmostApplication?.localizedName { print(n) }

case "activate":
    let name = args.count >= 3 ? args[2] : ""
    if let app = NSWorkspace.shared.runningApplications.first(where: { $0.localizedName == name }) {
        app.activate(options: [])
    }

case "modifiers":
    // Match the old osascript mapping: (flags div 131072 mod 16) → 4 bits at
    // Shift(1<<17)/Ctrl/Option/Command. 0 means nothing held.
    let f = NSEvent.modifierFlags.rawValue
    print((f >> 17) & 0xF)

case "paste", "replace", "delete":
    // Posting synthetic keystrokes requires Accessibility. Fail loudly (non-zero
    // exit) when it isn't granted so the parent surfaces the permission error
    // instead of silently pasting nothing.
    guard AXIsProcessTrusted() else {
        FileHandle.standardError.write("accessibility-denied\n".data(using: .utf8)!)
        exit(1)
    }
    let n = args.count >= 3 ? (Int(args[2]) ?? 0) : 0
    switch args[1] {
    case "paste":
        postKey(kV, flags: .maskCommand)
    case "replace":
        for _ in 0..<n { postKey(kLeft, flags: .maskShift) }
        postKey(kV, flags: .maskCommand)
    default: // delete
        for _ in 0..<n { postKey(kLeft, flags: .maskShift) }
        postKey(kDelete, flags: [])
    }

default:
    FileHandle.standardError.write("unknown action \(args[1])\n".data(using: .utf8)!)
    exit(2)
}
