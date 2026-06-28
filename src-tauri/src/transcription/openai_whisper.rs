use std::path::Path;
use super::{TranscriptionResult, TranscriptionSegment};
use reqwest::multipart;

pub async fn transcribe_with_confidence(
    api_key: &str,
    model: &str,
    wav_path: &Path,
    language: &str,
) -> Result<TranscriptionResult, String> {
    let file_bytes = std::fs::read(wav_path).map_err(|e| format!("Read audio: {}", e))?;
    let file_name = wav_path.file_name().unwrap_or_default().to_string_lossy().to_string();

    let mut form = multipart::Form::new()
        .part("file", multipart::Part::bytes(file_bytes).file_name(file_name).mime_str("audio/wav").unwrap())
        .text("model", model.to_string())
        .text("response_format", "verbose_json");

    if !language.is_empty() && language != "auto" {
        form = form.text("language", language.to_string());
    }

    let client = reqwest::Client::new();
    let response = client
        .post("https://api.openai.com/v1/audio/transcriptions")
        .header("Authorization", format!("Bearer {}", api_key))
        .multipart(form)
        .timeout(std::time::Duration::from_secs(30))
        .send()
        .await
        .map_err(|e| format!("OpenAI Whisper request failed: {}", e))?;

    if !response.status().is_success() {
        let body = response.text().await.unwrap_or_default();
        return Err(format!("OpenAI Whisper API error: {}", body));
    }

    let data: serde_json::Value = response.json().await.map_err(|e| format!("Parse: {}", e))?;
    let text = data["text"].as_str().unwrap_or("").trim().to_string();

    let segments: Vec<TranscriptionSegment> = data["segments"]
        .as_array()
        .map(|segs| {
            segs.iter().map(|s| TranscriptionSegment {
                text: s["text"].as_str().unwrap_or("").trim().to_string(),
                confidence: s["avg_logprob"].as_f64().map(|p| p.exp()).unwrap_or(1.0),
                start: s["start"].as_f64().unwrap_or(0.0),
                end: s["end"].as_f64().unwrap_or(0.0),
            }).collect()
        })
        .unwrap_or_default();

    Ok(TranscriptionResult { text, segments })
}

pub async fn validate_api_key(api_key: &str) -> (bool, Option<String>) {
    let client = reqwest::Client::new();
    match client
        .get("https://api.openai.com/v1/models")
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
