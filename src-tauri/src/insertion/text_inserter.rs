use std::process::Command;
use std::sync::{LazyLock, Mutex};
use std::time::Duration;
use arboard::Clipboard;

/// Per-dictation-session clipboard state. Live/instant injection replaces the
/// user's clipboard for the duration of a dictation; we snapshot it once before
/// the first paste and restore it when the session ends (mirrors the
/// `savedClipboard`/`lastClipboardWrite` fields on `TextInserter` in the
/// Electron `textInserter.ts`).
#[derive(Default)]
struct SessionClipboard {
    /// User clipboard captured before the first paste of a session.
    saved: Option<String>,
    /// The text we most recently wrote to the clipboard (restore guard).
    last_write: Option<String>,
}

static SESSION: LazyLock<Mutex<SessionClipboard>> =
    LazyLock::new(|| Mutex::new(SessionClipboard::default()));

/// Capture the user's clipboard once per dictation session (before we touch it).
fn snapshot_clipboard_once() {
    let mut s = SESSION.lock().unwrap();
    if s.saved.is_some() {
        return;
    }
    if let Ok(mut cb) = Clipboard::new() {
        s.saved = Some(cb.get_text().unwrap_or_default());
    } else {
        // Couldn't read — still mark the session started so we don't clobber a
        // later read with a stale one.
        s.saved = Some(String::new());
    }
}

fn record_clipboard_write(text: &str) {
    SESSION.lock().unwrap().last_write = Some(text.to_string());
}

/// Restore the clipboard captured at the start of the session. Safe to call from
/// every pipeline exit path — it no-ops when there is nothing to restore, and
/// never clobbers a copy the user made mid-dictation.
pub async fn restore_user_clipboard() {
    let (saved, last_write) = {
        let mut s = SESSION.lock().unwrap();
        (s.saved.take(), s.last_write.take())
    };
    let Some(saved) = saved else { return };

    // Allow the last paste to complete before we swap the clipboard back.
    tokio::time::sleep(Duration::from_millis(150)).await;

    if let Ok(mut cb) = Clipboard::new() {
        let current = cb.get_text().unwrap_or_default();
        if last_write.as_deref() == Some(current.as_str()) {
            let _ = cb.set_text(&saved);
            log::info!("[inserter] Clipboard restored");
        } else {
            log::info!("[inserter] Clipboard changed externally, skipping restore");
        }
    }
}

/// Run the `text-insert` Swift helper with one action. The helper posts
/// keystrokes via CGEvent (needs only Accessibility, no Automation) and reads
/// frontmost/modifiers via AppKit (no permission), replacing the old osascript /
/// System Events path — which the dev binary can't use because it lacks an
/// Info.plist Automation usage string. Returns trimmed stdout on exit-0.
fn insert_helper(args: &[&str]) -> Option<String> {
    let bin = crate::utils::swift_binary::get_binary_path("text-insert");
    Command::new(bin)
        .args(args)
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
}

/// True if the keystroke helper reported the paste/replace/delete succeeded
/// (exit 0). A non-zero exit means Accessibility isn't granted to the helper.
fn insert_helper_ok(args: &[&str]) -> bool {
    let bin = crate::utils::swift_binary::get_binary_path("text-insert");
    Command::new(bin)
        .args(args)
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

fn activate_app(app: &str) {
    let _ = insert_helper(&["activate", app]);
}

/// Read the frontmost process name (None on failure).
fn frontmost_app() -> Option<String> {
    insert_helper(&["frontmost"]).filter(|s| !s.is_empty())
}

/// Modifier bitmask (Cmd/Shift/Ctrl/Option) currently held, or -1 if unreadable.
fn modifier_bits() -> i32 {
    insert_helper(&["modifiers"])
        .and_then(|s| s.parse::<i32>().ok())
        .unwrap_or(-1)
}

/// Bring the target app forward only when it isn't already frontmost.
async fn ensure_app_focus(target_app: &str) {
    if frontmost_app().as_deref() == Some(target_app) {
        return;
    }
    activate_app(target_app);
    tokio::time::sleep(Duration::from_millis(200)).await;
}

/// Reads the frontmost process and the held modifier keys (via the AppKit-backed
/// `text-insert` helper), then performs only the expensive steps actually needed:
/// activating the target app (200ms settle) and waiting for modifier release.
/// In the common case (target already focused, hotkey long released) this
/// replaces ~530ms of fixed sleeps with a single ~60ms check. Mirrors
/// `prepareForPaste` in `textInserter.ts`.
async fn prepare_for_paste(target_app: Option<&str>) {
    let frontmost: Option<String> = frontmost_app();
    let modifiers: i32 = modifier_bits();

    if let Some(app) = target_app {
        if frontmost.as_deref() != Some(app) {
            activate_app(app);
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
    }

    if modifiers == 0 {
        return; // keys already released — paste immediately
    }
    if modifiers < 0 {
        // Couldn't read modifier state — keep the old conservative fixed delay.
        tokio::time::sleep(Duration::from_millis(300)).await;
        return;
    }
    // Modifiers still held (hotkey release in flight) — poll briefly.
    let deadline = std::time::Instant::now() + Duration::from_millis(600);
    while std::time::Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(100)).await;
        if modifier_bits() == 0 {
            return;
        }
    }
}

/// Insert text via clipboard paste (Cmd+V). Skips the activate/modifier waits
/// when they aren't needed, and restores the user's clipboard afterwards
/// (session-aware: if live text was injected earlier, the clipboard from
/// *before* the first injection is restored).
pub async fn insert(text: &str, target_app: Option<&str>) -> Result<(), String> {
    prepare_for_paste(target_app).await;

    snapshot_clipboard_once();

    let mut clipboard = Clipboard::new().map_err(|e| format!("Clipboard: {}", e))?;
    clipboard.set_text(text).map_err(|e| format!("Set clipboard: {}", e))?;
    record_clipboard_write(text);

    tokio::time::sleep(Duration::from_millis(30)).await;

    if !insert_helper_ok(&["paste"]) {
        return Err("Paste keystroke failed. Check Accessibility permissions.".into());
    }

    log::info!("[inserter] Pasted {} chars into {}", text.chars().count(), target_app.unwrap_or("focused app"));

    restore_user_clipboard().await;
    Ok(())
}

/// Lightweight insert for live streaming — pastes without waiting on modifier
/// release. Returns whether the paste actually happened so callers only track
/// text that is really on screen (a phantom count would make the later replace
/// step delete the user's own text).
///
/// Pass `target_app` to re-focus the source app first (used by the pipeline's
/// instant insert, where the user may have switched apps since recording). The
/// live-streaming path omits it — focus hasn't moved mid-recording, and per-chunk
/// activation would steal focus.
pub async fn insert_live(text: &str, target_app: Option<&str>) -> bool {
    if text.is_empty() {
        return false;
    }
    if let Some(app) = target_app {
        ensure_app_focus(app).await;
    }
    snapshot_clipboard_once();

    let mut clipboard = match Clipboard::new() {
        Ok(c) => c,
        Err(e) => {
            log::warn!("[inserter] Live insert failed (clipboard): {}", e);
            return false;
        }
    };
    if clipboard.set_text(text).is_err() {
        return false;
    }
    record_clipboard_write(text);

    tokio::time::sleep(Duration::from_millis(20)).await;

    if insert_helper_ok(&["paste"]) {
        true
    } else {
        log::warn!("[inserter] Live insert paste failed");
        false
    }
}

/// Replace live-injected text with refined text. Selects back over the
/// live-injected characters, then pastes the replacement. An empty `refined`
/// deletes the selection with a real Delete keypress — pasting an empty
/// clipboard can no-op in some apps and leave text selected — and never touches
/// the clipboard (so undo can reuse this path).
pub async fn replace_live_text(refined: &str, live_char_count: usize, target_app: Option<&str>) -> Result<(), String> {
    if live_char_count == 0 && refined.is_empty() {
        return Ok(());
    }
    prepare_for_paste(target_app).await;

    if refined.is_empty() {
        // Select back over the live chars and delete them in one helper call.
        let _ = insert_helper_ok(&["delete", &live_char_count.to_string()]);
        log::info!("[inserter] Deleted {} live chars", live_char_count);
        return Ok(());
    }

    snapshot_clipboard_once();
    let mut clipboard = Clipboard::new().map_err(|e| format!("Clipboard: {}", e))?;
    clipboard.set_text(refined).map_err(|e| format!("Set clipboard: {}", e))?;
    record_clipboard_write(refined);
    tokio::time::sleep(Duration::from_millis(30)).await;

    // Select back over the live chars, then paste the replacement.
    if !insert_helper_ok(&["replace", &live_char_count.to_string()]) {
        log::warn!("[inserter] Replace failed, falling back to append");
        return insert(refined, target_app).await;
    }

    log::info!("[inserter] Replaced {} chars with {} refined chars", live_char_count, refined.chars().count());
    Ok(())
}

/// Undo the last insertion: select back over the inserted characters and delete
/// them, reusing the same pure-Delete path as the EMPTY-sentinel cleanup. Counts
/// Unicode scalar values so multi-byte characters select correctly. Never touches
/// the clipboard.
pub async fn undo_last_insertion(text: &str, target_app: Option<&str>) -> Result<(), String> {
    let count = text.chars().count();
    if count == 0 {
        return Ok(());
    }
    replace_live_text("", count, target_app).await
}

pub fn check_permissions() -> (bool, String) {
    match insert_helper(&["check-ax"]).as_deref() {
        Some("ax-granted") => (true, "Accessibility permissions granted".into()),
        _ => (false, "Accessibility permission required. Go to System Settings > Privacy & Security > Accessibility and add Echo.".into()),
    }
}

/// Prompt for Accessibility once and register the `text-insert` helper in the
/// System Settings list so the user can grant it. Call at startup after ensuring
/// the binary exists. Returns true if already trusted.
pub fn ensure_accessibility() -> bool {
    insert_helper(&["ensure-ax"]).as_deref() == Some("ax-granted")
}
