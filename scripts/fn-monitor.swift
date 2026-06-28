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
            print("fn-down")
            fflush(stdout)
        } else if !fnPressed && fnIsDown {
            fnIsDown = false
            print("fn-up")
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

let eventMask: CGEventMask = 1 << CGEventType.flagsChanged.rawValue

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
