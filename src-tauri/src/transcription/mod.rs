pub mod whisper;
pub mod groq;
pub mod deepgram;
pub mod openai_whisper;
pub mod macos;
pub mod live;
pub mod speech_bias;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TranscriptionSegment {
    pub text: String,
    pub confidence: f64,
    pub start: f64,
    pub end: f64,
}

#[derive(Debug)]
pub struct TranscriptionResult {
    pub text: String,
    pub segments: Vec<TranscriptionSegment>,
}

/// Whether an STT error is worth a quick retry (transient) vs. one that won't
/// improve on a second attempt (bad/missing API key, engine not installed) — for
/// the latter we skip straight to the local-whisper fallback. Mirrors
/// `isRetryableSttError` in pipeline.ts.
fn is_retryable_stt_error(message: &str) -> bool {
    let lower = message.to_lowercase();
    if lower.contains("401") || lower.contains("403") || lower.contains("invalid api key") || lower.contains("api key") {
        return false;
    }
    if lower.contains("not found") || lower.contains("not ready") || lower.contains("not configured") || lower.contains("not set up") {
        return false;
    }
    true
}

/// Transcribe with resilience: retry the configured engine once on a transient
/// failure, then — if it still fails and isn't already local whisper — fall back
/// to local whisper.cpp (when it's installed) so a cloud/engine outage doesn't
/// lose the dictation. Returns the engine that actually produced the text.
/// Mirrors `transcribeWithFallback` in pipeline.ts.
pub async fn transcribe_with_fallback(
    engine: &str,
    clean_path: &std::path::Path,
    wav_path: &std::path::Path,
    settings: &crate::settings::SettingsStore,
    bias_prompt: &str,
) -> Result<(TranscriptionResult, String), String> {
    let mut primary_err = match transcribe_audio(engine, clean_path, wav_path, settings, bias_prompt).await {
        Ok(result) => return Ok((result, engine.to_string())),
        Err(e) => {
            log::warn!("[pipeline] STT engine {} failed: {}", engine, e);
            e
        }
    };

    // One quick retry for transient failures (network blip, warm-server hiccup).
    if is_retryable_stt_error(&primary_err) {
        tokio::time::sleep(std::time::Duration::from_millis(400)).await;
        log::info!("[pipeline] Retrying {}...", engine);
        match transcribe_audio(engine, clean_path, wav_path, settings, bias_prompt).await {
            Ok(result) => return Ok((result, engine.to_string())),
            Err(e) => {
                log::warn!("[pipeline] Retry of {} failed: {}", engine, e);
                primary_err = e;
            }
        }
    }

    // Fall back to local whisper.cpp — but only if it's a different engine and
    // actually usable (binary + model present); otherwise there's nothing to fall
    // back to and we surface the original error.
    if engine != "whisper" {
        let model_name = settings.get(|s| s.whisper_model_name.clone());
        let (bin_ok, model_ok) = whisper::is_ready(&model_name);
        if bin_ok && model_ok {
            log::warn!("[pipeline] Falling back to local whisper after {} failed", engine);
            // whisper transcribes the raw WAV (it doesn't use the cleaned upload file).
            return match transcribe_audio("whisper", wav_path, wav_path, settings, bias_prompt).await {
                Ok(result) => Ok((result, "whisper".to_string())),
                Err(e) => {
                    log::error!("[pipeline] Local whisper fallback also failed: {}", e);
                    // Surface the fallback error — it's the actionable one.
                    Err(e)
                }
            };
        }
        log::warn!("[pipeline] Local whisper not available for fallback (build/download it in Settings)");
    }

    Err(primary_err)
}

pub async fn transcribe_audio(
    engine: &str,
    clean_path: &std::path::Path,
    wav_path: &std::path::Path,
    settings: &crate::settings::SettingsStore,
    bias_prompt: &str,
) -> Result<TranscriptionResult, String> {
    let lang = settings.get(|s| s.transcription_language.clone());
    match engine {
        "groq" => {
            let key = settings.get(|s| s.groq_api_key.clone());
            // Compress the upload (FLAC by default) to cut upload bytes, mirroring
            // the Electron pipeline. Falls back to the WAV on any encode failure.
            let upload_path = crate::audio::recorder::AudioRecorder::encode_for_upload(clean_path);
            let result = groq::transcribe(&key, &upload_path, bias_prompt, &lang).await;
            if upload_path.as_path() != clean_path {
                let _ = std::fs::remove_file(&upload_path);
            }
            let text = result?;
            Ok(TranscriptionResult { text, segments: vec![] })
        }
        "macos" => {
            // macOS Speech has no prior-context biasing.
            let text = macos::transcribe(wav_path).await?;
            Ok(TranscriptionResult { text, segments: vec![] })
        }
        "deepgram" => {
            let key = settings.get(|s| s.deepgram_api_key.clone());
            deepgram::transcribe_with_confidence(&key, clean_path, &lang).await
        }
        "openai-whisper" => {
            let key = settings.get(|s| s.openai_api_key.clone());
            let model = settings.get(|s| s.openai_whisper_model.clone());
            openai_whisper::transcribe_with_confidence(&key, &model, clean_path, &lang, bias_prompt).await
        }
        _ => {
            // Local whisper.cpp (default, free). Bias decoding toward jargon and
            // honor the configured language for accent handling.
            let model_name = settings.get(|s| s.whisper_model_name.clone());
            // Warm-server path first (keeps the model loaded between dictations);
            // falls back silently to the one-shot CLI on any failure.
            let text = match whisper::transcribe_via_server(wav_path, &model_name, &lang, bias_prompt).await {
                Some(t) => t,
                None => whisper::transcribe(wav_path, &model_name, &lang, bias_prompt)?,
            };
            Ok(TranscriptionResult { text, segments: vec![] })
        }
    }
}
