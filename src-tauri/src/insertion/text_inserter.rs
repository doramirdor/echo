use std::process::Command;
use arboard::Clipboard;

fn activate_app(app: &str) {
    let escaped = app.replace('\\', "\\\\").replace('"', "\\\"");
    let _ = Command::new("osascript")
        .args(["-e", &format!("tell application \"{}\" to activate", escaped)])
        .output();
    std::thread::sleep(std::time::Duration::from_millis(200));
}

async fn wait_for_modifier_release() {
    tokio::time::sleep(std::time::Duration::from_millis(300)).await;
}

pub async fn insert(text: &str, target_app: Option<&str>) -> Result<(), String> {
    if let Some(app) = target_app {
        activate_app(app);
    }
    wait_for_modifier_release().await;

    let mut clipboard = Clipboard::new().map_err(|e| format!("Clipboard: {}", e))?;
    let previous = clipboard.get_text().unwrap_or_default();

    clipboard.set_text(text).map_err(|e| format!("Set clipboard: {}", e))?;
    tokio::time::sleep(std::time::Duration::from_millis(30)).await;

    let output = Command::new("osascript")
        .args(["-e", "tell application \"System Events\" to keystroke \"v\" using {command down}"])
        .output()
        .map_err(|e| format!("Paste failed: {}", e))?;

    if !output.status.success() {
        return Err("Paste keystroke failed. Check Accessibility permissions.".into());
    }

    log::info!("[inserter] Pasted {} chars into {}", text.len(), target_app.unwrap_or("focused app"));

    tokio::time::sleep(std::time::Duration::from_millis(150)).await;

    if clipboard.get_text().unwrap_or_default() == text {
        let _ = clipboard.set_text(&previous);
        log::info!("[inserter] Clipboard restored");
    }

    Ok(())
}

pub async fn insert_live(text: &str) -> Result<(), String> {
    if text.is_empty() { return Ok(()); }
    let mut clipboard = Clipboard::new().map_err(|e| format!("Clipboard: {}", e))?;
    clipboard.set_text(text).map_err(|e| format!("Set clipboard: {}", e))?;
    tokio::time::sleep(std::time::Duration::from_millis(20)).await;

    let _ = Command::new("osascript")
        .args(["-e", "tell application \"System Events\" to keystroke \"v\" using {command down}"])
        .output();
    Ok(())
}

pub async fn replace_live_text(refined: &str, live_char_count: usize, target_app: Option<&str>) -> Result<(), String> {
    if let Some(app) = target_app {
        activate_app(app);
    }
    wait_for_modifier_release().await;

    let script = format!(
        "tell application \"System Events\"\nrepeat {} times\nkey code 123 using {{shift down}}\nend repeat\nkeystroke \"v\" using {{command down}}\nend tell",
        live_char_count
    );

    let mut clipboard = Clipboard::new().map_err(|e| format!("Clipboard: {}", e))?;
    let previous = clipboard.get_text().unwrap_or_default();
    clipboard.set_text(refined).map_err(|e| format!("Set clipboard: {}", e))?;
    tokio::time::sleep(std::time::Duration::from_millis(30)).await;

    let output = Command::new("osascript")
        .args(["-e", &script])
        .output()
        .map_err(|e| format!("Replace failed: {}", e))?;

    if !output.status.success() {
        log::warn!("[inserter] Replace failed, falling back to append");
        return insert(refined, target_app).await;
    }

    log::info!("[inserter] Replaced {} chars with {} refined chars", live_char_count, refined.len());

    tokio::time::sleep(std::time::Duration::from_millis(150)).await;
    if clipboard.get_text().unwrap_or_default() == refined {
        let _ = clipboard.set_text(&previous);
    }
    Ok(())
}

pub fn check_permissions() -> (bool, String) {
    let output = Command::new("osascript")
        .args(["-e", "tell application \"System Events\" to get name of first process"])
        .output();

    match output {
        Ok(o) if o.status.success() => (true, "Accessibility permissions granted".into()),
        _ => (false, "Accessibility permission required. Go to System Settings > Privacy & Security > Accessibility and add Echo.".into()),
    }
}
