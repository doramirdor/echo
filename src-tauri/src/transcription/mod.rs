pub mod whisper;
pub mod groq;
pub mod deepgram;
pub mod openai_whisper;
pub mod macos;
pub mod live;

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
) -> Result<TranscriptionResult, String> {
    match engine {
        "groq" => {
            let key = settings.get(|s| s.groq_api_key.clone());
            let text = groq::transcribe(&key, clean_path).await?;
            Ok(TranscriptionResult { text, segments: vec![] })
        }
        "macos" => {
            let text = macos::transcribe(wav_path).await?;
            Ok(TranscriptionResult { text, segments: vec![] })
        }
        "deepgram" => {
            let key = settings.get(|s| s.deepgram_api_key.clone());
            let lang = settings.get(|s| s.transcription_language.clone());
            deepgram::transcribe_with_confidence(&key, clean_path, &lang).await
        }
        "openai-whisper" => {
            let key = settings.get(|s| s.openai_api_key.clone());
            let model = settings.get(|s| s.openai_whisper_model.clone());
            let lang = settings.get(|s| s.transcription_language.clone());
            openai_whisper::transcribe_with_confidence(&key, &model, clean_path, &lang).await
        }
        _ => {
            let model_name = settings.get(|s| s.whisper_model_name.clone());
            let text = whisper::transcribe(wav_path, &model_name)?;
            Ok(TranscriptionResult { text, segments: vec![] })
        }
    }
}
