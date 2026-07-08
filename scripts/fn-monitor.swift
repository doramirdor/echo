import Foundation
import CoreGraphics
import IOKit.hid

// Monitors the fn/Globe key via CGEventTap on flagsChanged events.
// Outputs "fn-down" and "fn-up" lines to stdout for the parent Electron process.
//
// Requires INPUT MONITORING permission (separate from Accessibility): a listen-only
// keyboard event tap is created successfully without it but silently receives no
// events. We request it explicitly so macOS shows the prompt.
//
// NOTE: The user should set System Settings > Keyboard > "Press fn key to" → "Do Nothing"
// so macOS doesn't consume the fn key for the emoji picker or dictation.

// --- TCC responsibility disclaim (fixes the "fn dies after every rebuild" drift) ---
// macOS attributes an Input Monitoring grant to the *responsible process*, which
// for a spawned helper defaults to the parent app. In development the parent is
// an ad-hoc-signed binary (Electron `Echo.app` or `cargo tauri dev`'s
// `target/debug/echo`) whose cdhash changes on every build, so the grant TCC
// stored against it silently drops and the fn key stops receiving events until
// the user re-approves — every single rebuild.
//
// We break that link by re-spawning ourselves *disclaimed*: a disclaimed process
// is its own responsible process, so TCC keys the Input Monitoring grant on
// THIS helper's own stable cdhash (re-signed as `com.echo.fn-monitor`) instead
// of the volatile parent. The user then approves once and it survives rebuilds.
//
// `responsibility_spawnattrs_setdisclaim` is a private-but-stable libSystem SPI
// (used by Chromium, Hammerspoon, etc.). If anything here fails we fall through
// and run the monitor inline — the hotkey still works, it just drifts as before.
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
    // Re-exec with the same argv, inheriting our stdio (fds 0/1/2) so the parent
    // talks to the disclaimed child directly. Mark the child via env so it runs
    // the monitor instead of relaunching again.
    var argv: [UnsafeMutablePointer<CChar>?] = CommandLine.arguments.map { strdup($0) }
    argv.append(nil)
    var env: [UnsafeMutablePointer<CChar>?] = ProcessInfo.processInfo.environment.map {
        strdup("\($0.key)=\($0.value)")
    }
    env.append(strdup("ECHO_FN_DISCLAIMED=1"))
    env.append(nil)
    defer {
        for p in argv where p != nil { free(p) }
        for p in env where p != nil { free(p) }
    }

    var pid: pid_t = 0
    guard posix_spawn(&pid, exePath, nil, &attr, &argv, &env) == 0 else { return false }

    // Wait for the disclaimed child and propagate its exit status. Our stdin
    // (the parent's control pipe) is inherited by the child, so "quit" and pipe
    // EOF reach it directly and terminate it — no separate forwarding needed.
    var status: Int32 = 0
    waitpid(pid, &status, 0)
    exit((status & 0x7f) == 0 ? (status >> 8) & 0xff : 1)
}

// Packaged builds set ECHO_NO_DISCLAIM=1: the parent app's identity is stable
// there, so we run inline and let TCC key the grant on "Echo" itself (one row in
// Input Monitoring, matching the onboarding instructions). Dev leaves it unset,
// so we still disclaim to survive the parent's per-rebuild cdhash churn.
if ProcessInfo.processInfo.environment["ECHO_NO_DISCLAIM"] == nil,
   ProcessInfo.processInfo.environment["ECHO_FN_DISCLAIMED"] == nil {
    if relaunchDisclaimed() {
        // relaunchDisclaimed calls exit() on success; unreachable.
    } else {
        FileHandle.standardError.write(
            "disclaim: could not re-spawn disclaimed; running inline (grant may drift on rebuild)\n"
                .data(using: .utf8)!)
    }
}

// --- Input Monitoring permission ---
// This is the process that actually needs the permission, so it is the
// authoritative source of truth. Check (and request) here, then emit a
// machine-readable status line on stdout ("im-granted"/"im-denied"/"im-unknown")
// so the parent can surface it in onboarding — instead of a separate checker
// binary whose TCC identity may not match this one.
var imAccess = IOHIDCheckAccess(kIOHIDRequestTypeListenEvent)
if imAccess != kIOHIDAccessTypeGranted {
    FileHandle.standardError.write("input-monitoring: not granted (status \(imAccess.rawValue)); requesting…\n".data(using: .utf8)!)
    _ = IOHIDRequestAccess(kIOHIDRequestTypeListenEvent)
    imAccess = IOHIDCheckAccess(kIOHIDRequestTypeListenEvent)
    if imAccess != kIOHIDAccessTypeGranted {
        FileHandle.standardError.write("input-monitoring: DENIED — grant Echo in System Settings > Privacy & Security > Input Monitoring, then restart.\n".data(using: .utf8)!)
    }
}
switch imAccess {
case kIOHIDAccessTypeGranted: print("im-granted")
case kIOHIDAccessTypeDenied: print("im-denied")
default: print("im-unknown")
}
fflush(stdout)

let fnModifierFlag: UInt64 = 0x00800000  // NX_SECONDARYFNMASK / kCGEventFlagMaskSecondaryFn

var fnIsDown = false
// True once a non-fn key has gone down during the current fn hold, meaning fn is
// being used as a modifier for an OS shortcut (e.g. fn+Delete, fn+←) rather than
// as Echo's standalone hotkey. Reset on every fresh fn-down.
var fnComboUsed = false
var eventTap: CFMachPort?

func eventCallback(
    proxy: CGEventTapProxy,
    type: CGEventType,
    event: CGEvent,
    refcon: UnsafeMutableRawPointer?
) -> Unmanaged<CGEvent>? {
    if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
        if let tap = eventTap {
            CGEvent.tapEnable(tap: tap, enable: true)
        }
        return Unmanaged.passUnretained(event)
    }

    if type == .flagsChanged {
        let flags = event.flags.rawValue
        let fnPressed = (flags & fnModifierFlag) != 0

        if fnPressed && !fnIsDown {
            fnIsDown = true
            fnComboUsed = false
            print("fn-down")
            fflush(stdout)
        } else if !fnPressed && fnIsDown {
            fnIsDown = false
            print("fn-up")
            fflush(stdout)
        }
    } else if type == .keyDown {
        // Any other key going down while fn is held means fn is being used as a
        // modifier (an OS shortcut), not as a standalone press — tell the parent
        // to cancel/ignore this hold so it doesn't trigger a recording.
        if fnIsDown && !fnComboUsed {
            fnComboUsed = true
            print("fn-combo")
            fflush(stdout)
        }
    }

    return Unmanaged.passUnretained(event)
}

DispatchQueue.global().async {
    while let line = readLine() {
        if line == "quit" { break }
    }
    exit(0)
}

let eventMask: CGEventMask = (1 << CGEventType.flagsChanged.rawValue) | (1 << CGEventType.keyDown.rawValue)

guard let tap = CGEvent.tapCreate(
    tap: .cgSessionEventTap,
    place: .headInsertEventTap,
    options: .listenOnly,
    eventsOfInterest: eventMask,
    callback: eventCallback,
    userInfo: nil
) else {
    FileHandle.standardError.write("Failed to create event tap. Grant Accessibility permissions.\n".data(using: .utf8)!)
    exit(1)
}

eventTap = tap

let runLoopSource = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0)
CFRunLoopAddSource(CFRunLoopGetMain(), runLoopSource, .commonModes)

print("ready")
fflush(stdout)

CFRunLoopRun()
