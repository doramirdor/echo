use serde::{Deserialize, Serialize};
use std::process::Command;

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
