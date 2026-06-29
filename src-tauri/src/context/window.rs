use serde::{Deserialize, Serialize};
use std::process::Command;

use crate::utils::swift_binary;

/// Text on either side of the caret in the focused field, read via the
/// Accessibility API (`field-context` Swift helper). Used for caret-aware
/// sentence continuation. Mirrors `captureFieldContext` in
/// `src/main/context/windowContext.ts`.
#[derive(Debug, Clone, Default)]
pub struct FieldContext {
    pub before: String,
    pub after: String,
    pub selected: String,
}

#[derive(Deserialize)]
struct FieldContextJson {
    #[serde(default)]
    before: String,
    #[serde(default)]
    after: String,
    #[serde(default)]
    selected: String,
}

/// Read the focused field's text split at the caret. Falls back to the
/// coarser `capture_window_context()` (whole field value as `before`) when the
/// dedicated binary isn't available, and to empty when nothing can be read.
pub fn capture_field_context() -> FieldContext {
    let bin = swift_binary::get_binary_path("field-context");
    if bin.exists() {
        let output = Command::new(&bin).output();
        if let Ok(o) = output {
            if o.status.success() {
                let stdout = String::from_utf8_lossy(&o.stdout);
                if let Ok(parsed) = serde_json::from_str::<FieldContextJson>(stdout.trim()) {
                    let fc = FieldContext {
                        before: parsed.before,
                        after: parsed.after,
                        selected: parsed.selected,
                    };
                    if !fc.before.is_empty() || !fc.after.is_empty() {
                        return fc;
                    }
                }
            }
        }
    }

    // Fallback: AppleScript window context exposes the whole field value but not
    // the caret split — treat it all as "before" (append case).
    let wctx = capture_window_context();
    FieldContext {
        before: wctx.existing_field_text,
        after: String::new(),
        selected: wctx.selected_text,
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct WindowContext {
    pub app_name: String,
    pub window_title: String,
    pub bundle_id: String,
    pub selected_text: String,
    pub existing_field_text: String,
}

pub fn capture_window_context() -> WindowContext {
    let script = r#"
    set output to ""
    set selText to ""
    set fieldText to ""
    try
      tell application "System Events"
        set frontApp to first application process whose frontmost is true
        set appName to name of frontApp
        set bundleId to bundle identifier of frontApp
        set output to appName & "|||" & bundleId
        try
          set winTitle to name of front window of frontApp
          set output to output & "|||" & winTitle
        on error
          set output to output & "|||"
        end try
        try
          set focusedElem to value of attribute "AXFocusedUIElement" of frontApp
          try
            set selText to value of attribute "AXSelectedText" of focusedElem
          end try
          try
            set fieldText to value of attribute "AXValue" of focusedElem
          end try
        on error
          set selText to ""
          set fieldText to ""
        end try
      end tell
    on error
      set output to "|||"
    end try
    return output & "|||" & selText & "|||" & fieldText
    "#;

    let output = Command::new("osascript")
        .args(["-e", script])
        .output();

    match output {
        Ok(o) if o.status.success() => {
            let stdout = String::from_utf8_lossy(&o.stdout);
            let parts: Vec<&str> = stdout.trim().split("|||").collect();
            WindowContext {
                app_name: parts.first().unwrap_or(&"").trim().to_string(),
                bundle_id: parts.get(1).unwrap_or(&"").trim().to_string(),
                window_title: parts.get(2).unwrap_or(&"").trim().to_string(),
                selected_text: parts.get(3).unwrap_or(&"").trim().to_string(),
                existing_field_text: parts.get(4).unwrap_or(&"").trim().to_string(),
            }
        }
        _ => WindowContext::default(),
    }
}

pub fn capture_screenshot() -> Option<String> {
    let tmp = std::env::temp_dir().join(format!("echo-ctx-{}.png", chrono::Utc::now().timestamp_millis()));
    let path_str = tmp.to_str()?;

    let output = Command::new("screencapture")
        .args(["-x", "-C", "-t", "png", path_str])
        .output();

    match output {
        Ok(o) if o.status.success() && tmp.exists() => Some(path_str.to_string()),
        _ => None,
    }
}

pub fn format_window_context(ctx: &WindowContext) -> String {
    if ctx.app_name.is_empty() && ctx.window_title.is_empty() {
        return String::new();
    }
    let mut parts = vec![];
    if !ctx.app_name.is_empty() { parts.push(format!("App: {}", ctx.app_name)); }
    if !ctx.bundle_id.is_empty() { parts.push(format!("Bundle: {}", ctx.bundle_id)); }
    if !ctx.window_title.is_empty() { parts.push(format!("Window: {}", ctx.window_title)); }
    if !ctx.selected_text.is_empty() { parts.push(format!("Selected text: {}", &ctx.selected_text[..ctx.selected_text.len().min(300)])); }
    if !ctx.existing_field_text.is_empty() { parts.push(format!("Existing text in field: {}", &ctx.existing_field_text[..ctx.existing_field_text.len().min(500)])); }
    parts.join("\n")
}

pub fn cleanup_screenshot(path: &str) {
    let _ = std::fs::remove_file(path);
}

/// Compress a PNG screenshot to JPEG, resized to max 1024px on the longest side,
/// via macOS `sips`. Returns the JPEG path, or the original on failure. Mirrors
/// compressScreenshot in src/main/context/windowContext.ts.
pub fn compress_screenshot(png_path: &str) -> String {
    let jpeg_path = match png_path.strip_suffix(".png") {
        Some(stripped) => format!("{}.jpg", stripped),
        None => format!("{}.jpg", png_path),
    };

    let output = Command::new("sips")
        .args([
            "--resampleHeightWidthMax", "1024",
            "--setProperty", "format", "jpeg",
            "--setProperty", "formatOptions", "50", // 50% quality
            png_path,
            "--out", &jpeg_path,
        ])
        .output();

    match output {
        Ok(o) if o.status.success() && std::path::Path::new(&jpeg_path).exists() => jpeg_path,
        _ => {
            log::warn!("[context] Screenshot compression failed, using original");
            png_path.to_string()
        }
    }
}

/// Base64-encode a screenshot file for a vision API request body.
pub fn screenshot_to_base64(path: &str) -> Option<String> {
    use base64::Engine;
    std::fs::read(path)
        .ok()
        .map(|bytes| base64::engine::general_purpose::STANDARD.encode(bytes))
}

/// Media type for a screenshot path (jpeg if compressed, else png).
pub fn screenshot_media_type(path: &str) -> &'static str {
    if path.ends_with(".jpg") || path.ends_with(".jpeg") {
        "image/jpeg"
    } else {
        "image/png"
    }
}
