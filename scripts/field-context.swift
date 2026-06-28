import Foundation
import ApplicationServices
import AppKit

// Reads the focused text field's value and caret position via the Accessibility
// API, then prints JSON: { "before": ..., "after": ..., "selected": ... }.
//
// "before" / "after" are the text on either side of the insertion point, so the
// dictation pipeline can continue a sentence the user is in the middle of.
// Falls back gracefully (empty fields) when AX info isn't available.

func jsonString(_ s: String) -> String {
    let data = try? JSONSerialization.data(withJSONObject: [s], options: [])
    guard let data = data, let str = String(data: data, encoding: .utf8) else { return "\"\"" }
    // Strip the surrounding [ ] from the single-element array encoding.
    let trimmed = str.dropFirst().dropLast()
    return String(trimmed)
}

func emit(before: String, after: String, selected: String) -> Never {
    print("{\"before\":\(jsonString(before)),\"after\":\(jsonString(after)),\"selected\":\(jsonString(selected))}")
    exit(0)
}

// Must be a trusted accessibility client.
guard AXIsProcessTrusted() else {
    emit(before: "", after: "", selected: "")
}

let systemWide = AXUIElementCreateSystemWide()
var focused: AnyObject?
guard AXUIElementCopyAttributeValue(systemWide, kAXFocusedUIElementAttribute as CFString, &focused) == .success,
      let element = focused else {
    emit(before: "", after: "", selected: "")
}
let axElement = element as! AXUIElement

// Full value of the focused element.
var valueRef: AnyObject?
let value: String = {
    if AXUIElementCopyAttributeValue(axElement, kAXValueAttribute as CFString, &valueRef) == .success,
       let v = valueRef as? String {
        return v
    }
    return ""
}()

// Selected text (if any).
var selRef: AnyObject?
let selected: String = {
    if AXUIElementCopyAttributeValue(axElement, kAXSelectedTextAttribute as CFString, &selRef) == .success,
       let s = selRef as? String {
        return s
    }
    return ""
}()

// Selected text range → caret location.
var rangeRef: AnyObject?
var caretLoc = -1
var selLen = 0
if AXUIElementCopyAttributeValue(axElement, kAXSelectedTextRangeAttribute as CFString, &rangeRef) == .success,
   let rangeVal = rangeRef, CFGetTypeID(rangeVal) == AXValueGetTypeID() {
    var cfRange = CFRange()
    if AXValueGetValue(rangeVal as! AXValue, .cfRange, &cfRange) {
        caretLoc = cfRange.location
        selLen = cfRange.length
    }
}

if value.isEmpty {
    emit(before: "", after: "", selected: selected)
}

// Split the value at the caret. AX offsets are UTF-16 based.
let utf16 = Array(value.utf16)
if caretLoc < 0 || caretLoc > utf16.count {
    // Unknown caret → treat entire value as "before" (append case).
    emit(before: value, after: "", selected: selected)
}

let beforeUnits = Array(utf16[0..<caretLoc])
let afterStart = min(caretLoc + selLen, utf16.count)
let afterUnits = Array(utf16[afterStart..<utf16.count])
let before = String(utf16CodeUnits: beforeUnits, count: beforeUnits.count)
let after = String(utf16CodeUnits: afterUnits, count: afterUnits.count)

emit(before: before, after: after, selected: selected)
