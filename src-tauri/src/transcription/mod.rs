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
            let text = whisper::transcribe(wav_path, &model_name, &lang, bias_prompt)?;
            Ok(TranscriptionResult { text, segments: vec![] })
        }
    }
}
