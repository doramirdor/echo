use std::path::Path;
use reqwest::multipart;

pub async fn transcribe(api_key: &str, wav_path: &Path) -> Result<String, String> {
    let file_bytes = std::fs::read(wav_path)
        .map_err(|e| format!("Read audio file: {}", e))?;
    let file_name = wav_path.file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .to_string();

    let form = multipart::Form::new()
        .part("file", multipart::Part::bytes(file_bytes)
            .file_name(file_name)
            .mime_str("audio/wav")
            .unwrap())
        .text("model", "whisper-large-v3-turbo")
        .text("language", "en")
        .text("temperature", "0")
        .text("response_format", "verbose_json");

    let client = reqwest::Client::new();
    let response = client
        .post("https://api.groq.com/openai/v1/audio/transcriptions")
        .header("Authorization", format!("Bearer {}", api_key))
        .multipart(form)
        .timeout(std::time::Duration::from_secs(20))
        .send()
        .await
        .map_err(|e| {
            log::warn!("[groq] Fetch error, trying curl fallback: {}", e);
            transcribe_with_curl(api_key, wav_path).unwrap_or_else(|e2| format!("Both fetch and curl failed: {}", e2))
        })?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        return Err(format!("Groq API error {}: {}", status, body));
    }

    let data: serde_json::Value = response.json().await
        .map_err(|e| format!("Parse response: {}", e))?;
    let text = data["text"].as_str().unwrap_or("").trim().to_string();
    log::info!("[groq] Transcribed: \"{}\"", text);
    Ok(text)
}

fn transcribe_with_curl(api_key: &str, wav_path: &Path) -> Result<String, String> {
    log::info!("[groq] Falling back to curl --http2");
    let output = std::process::Command::new("curl")
        .args([
            "--silent", "--show-error", "--fail", "--http2",
            "--max-time", "20",
            "-X", "POST",
            "https://api.groq.com/openai/v1/audio/transcriptions",
            "-H", &format!("Authorization: Bearer {}", api_key),
            "-F", &format!("file=@{}", wav_path.to_str().unwrap_or("")),
            "-F", "model=whisper-large-v3-turbo",
            "-F", "language=en",
            "-F", "temperature=0",
            "-F", "response_format=verbose_json",
        ])
        .output()
        .map_err(|e| format!("curl failed: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("curl failed: {}", stderr));
    }

    let data: serde_json::Value = serde_json::from_slice(&output.stdout)
        .map_err(|e| format!("Parse curl response: {}", e))?;
    Ok(data["text"].as_str().unwrap_or("").trim().to_string())
}

pub async fn validate_api_key(api_key: &str) -> (bool, Option<String>) {
    let client = reqwest::Client::new();
    match client
        .get("https://api.groq.com/openai/v1/models")
        .header("Authorization", format!("Bearer {}", api_key))
        .timeout(std::time::Duration::from_secs(10))
        .send()
        .await
    {
        Ok(resp) if resp.status().is_success() => (true, None),
        Ok(resp) => (false, Some(format!("HTTP {}", resp.status()))),
        Err(e) => (false, Some(e.to_string())),
    }
}
