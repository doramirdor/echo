use std::process::Command;

/// The 🌐/fn key vs. Echo's primary hotkey.
///
/// macOS binds a lone fn (🌐) tap to a system action via the `AppleFnUsageType`
/// preference — the "Press 🌐 key to" dropdown in System Settings → Keyboard:
///   0 = Do Nothing, 1 = Change Input Source, 2 = Show Emoji & Symbols, 3 = Start Dictation.
/// When it's anything but 0 (1 is the built-in default on Macs with a globe key),
/// macOS consumes the fn tap for that action before Echo's listen-only event tap
/// ever sees it, so the fn hotkey looks dead. The tap must stay listen-only — an
/// active tap that swallowed fn would also break fn-as-modifier (fn+arrows,
/// fn+F-keys) — so the only clean fix is to set the pref to 0, the way Wispr Flow
/// and similar dictation apps do on first run. Mirror of
/// src/main/utils/fnKeyRelease.ts.

/// Read `AppleFnUsageType` from NSGlobalDomain, or None when unset/unreadable.
fn read_fn_usage_type() -> Option<i32> {
    let out = Command::new("defaults")
        .args(["read", "-g", "AppleFnUsageType"])
        .output()
        .ok()?;
    if !out.status.success() {
        // Key unset → macOS uses its built-in default ("Change Input Source" on
        // Macs with a globe key): not free.
        return None;
    }
    String::from_utf8_lossy(&out.stdout).trim().parse::<i32>().ok()
}

/// True when fn is already set to do nothing (Echo's hotkey is unobstructed).
pub fn is_fn_key_free() -> bool {
    read_fn_usage_type() == Some(0)
}

/// Set "Press 🌐 key to" → Do Nothing so a lone fn tap reaches Echo. Returns
/// whether the write succeeded. HIToolbox may only pick the change up at the next
/// login, so callers should tell the user to log out/in if fn is still captured.
pub fn free_fn_key() -> bool {
    Command::new("defaults")
        .args(["write", "-g", "AppleFnUsageType", "-int", "0"])
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}
