use std::path::Path;
use reqwest::multipart;

pub async fn transcribe(api_key: &str, wav_path: &Path, prompt: &str, language: &str) -> Result<String, String> {
    let file_bytes = std::fs::read(wav_path)
        .map_err(|e| format!("Read audio file: {}", e))?;
    let file_name = wav_path.file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .to_string();

    let lang = if language.is_empty() { "en" } else { language };
    let mut form = multipart::Form::new()
        .part("file", multipart::Part::bytes(file_bytes)
            .file_name(file_name)
            .mime_str("audio/wav")
            .unwrap())
        .text("model", "whisper-large-v3-turbo")
        .text("language", lang.to_string())
        .text("temperature", "0")
        .text("response_format", "verbose_json");
    // Prior-context biasing toward the user's vocabulary/jargon.
    if !prompt.is_empty() {
        form = form.text("prompt", prompt.to_string());
    }

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
            transcribe_with_curl(api_key, wav_path, prompt, lang).unwrap_or_else(|e2| format!("Both fetch and curl failed: {}", e2))
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

fn transcribe_with_curl(api_key: &str, wav_path: &Path, prompt: &str, language: &str) -> Result<String, String> {
    log::info!("[groq] Falling back to curl --http2");
    let mut args: Vec<String> = vec![
        "--silent".into(), "--show-error".into(), "--fail".into(), "--http2".into(),
        "--max-time".into(), "20".into(),
        "-X".into(), "POST".into(),
        "https://api.groq.com/openai/v1/audio/transcriptions".into(),
        "-H".into(), format!("Authorization: Bearer {}", api_key),
        "-F".into(), format!("file=@{}", wav_path.to_str().unwrap_or("")),
        "-F".into(), "model=whisper-large-v3-turbo".into(),
        "-F".into(), format!("language={}", language),
        "-F".into(), "temperature=0".into(),
        "-F".into(), "response_format=verbose_json".into(),
    ];
    if !prompt.is_empty() {
        args.push("-F".into());
        args.push(format!("prompt={}", prompt));
    }
    let output = std::process::Command::new("curl")
        .args(&args)
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
