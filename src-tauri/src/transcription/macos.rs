use std::path::Path;
use crate::utils::swift_binary;

pub async fn transcribe(wav_path: &Path) -> Result<String, String> {
    let bin = swift_binary::get_binary_path("transcribe");
    if !bin.exists() {
        return Err(format!("macOS transcriber not found at {:?}", bin));
    }

    let output = std::process::Command::new(bin.to_str().unwrap_or(""))
        .arg(wav_path.to_str().unwrap_or(""))
        .output()
        .map_err(|e| format!("macOS transcription failed: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("macOS transcription failed: {}", stderr));
    }

    let text = String::from_utf8_lossy(&output.stdout).trim().to_string();
    log::info!("[macos-stt] Transcribed: \"{}\"", text);
    Ok(text)
}
