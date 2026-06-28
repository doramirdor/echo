use std::path::Path;
use super::{TranscriptionResult, TranscriptionSegment};

pub async fn transcribe_with_confidence(
    api_key: &str,
    wav_path: &Path,
    language: &str,
) -> Result<TranscriptionResult, String> {
    let file_bytes = std::fs::read(wav_path)
        .map_err(|e| format!("Read audio: {}", e))?;

    let lang_param = if !language.is_empty() && language != "auto" {
        format!("&language={}", language)
    } else {
        String::new()
    };

    let url = format!(
        "https://api.deepgram.com/v1/listen?model=nova-2&smart_format=true&punctuate=true{}",
        lang_param
    );

    let client = reqwest::Client::new();
    let response = client
        .post(&url)
        .header("Authorization", format!("Token {}", api_key))
        .header("Content-Type", "audio/wav")
        .body(file_bytes)
        .timeout(std::time::Duration::from_secs(30))
        .send()
        .await
        .map_err(|e| format!("Deepgram request failed: {}", e))?;

    if !response.status().is_success() {
        let body = response.text().await.unwrap_or_default();
        return Err(format!("Deepgram API error: {}", body));
    }

    let data: serde_json::Value = response.json().await
        .map_err(|e| format!("Parse response: {}", e))?;

    let alt = &data["results"]["channels"][0]["alternatives"][0];
    let text = alt["transcript"].as_str().unwrap_or("").trim().to_string();

    let segments: Vec<TranscriptionSegment> = alt["words"]
        .as_array()
        .map(|words| {
            words.iter().map(|w| TranscriptionSegment {
                text: w["word"].as_str().unwrap_or("").to_string(),
                confidence: w["confidence"].as_f64().unwrap_or(1.0),
                start: w["start"].as_f64().unwrap_or(0.0),
                end: w["end"].as_f64().unwrap_or(0.0),
            }).collect()
        })
        .unwrap_or_default();

    Ok(TranscriptionResult { text, segments })
}

pub async fn validate_api_key(api_key: &str) -> (bool, Option<String>) {
    let client = reqwest::Client::new();
    match client
        .get("https://api.deepgram.com/v1/projects")
        .header("Authorization", format!("Token {}", api_key))
        .timeout(std::time::Duration::from_secs(10))
        .send()
        .await
    {
        Ok(resp) if resp.status().is_success() => (true, None),
        Ok(resp) => (false, Some(format!("HTTP {}", resp.status()))),
        Err(e) => (false, Some(e.to_string())),
    }
}
