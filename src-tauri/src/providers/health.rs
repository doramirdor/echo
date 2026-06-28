use serde::Serialize;
use crate::settings::SettingsStore;
use crate::audio::recorder::AudioRecorder;
use crate::insertion::text_inserter;
use crate::transcription::{whisper, groq, deepgram, openai_whisper};

#[derive(Debug, Serialize)]
pub struct ProviderStatus {
    pub id: String,
    pub label: String,
    pub ok: bool,
    pub message: String,
}

pub async fn check_all_providers(settings: &SettingsStore) -> Vec<ProviderStatus> {
    let mut results = vec![];

    let (ok, msg) = AudioRecorder::check_dependencies();
    results.push(ProviderStatus { id: "sox".into(), label: "SoX (audio)".into(), ok, message: msg });

    let (ok, msg) = text_inserter::check_permissions();
    results.push(ProviderStatus { id: "accessibility".into(), label: "Accessibility".into(), ok, message: msg });

    let model_name = settings.get(|s| s.whisper_model_name.clone());
    let (bin, model) = whisper::is_ready(&model_name);
    results.push(ProviderStatus {
        id: "whisper".into(), label: "Local Whisper".into(),
        ok: bin && model,
        message: if !bin { "Binary not built".into() } else if !model { "Model not downloaded".into() } else { "Ready".into() },
    });

    let groq_key = settings.get(|s| s.groq_api_key.clone());
    if !groq_key.is_empty() {
        let (valid, err) = groq::validate_api_key(&groq_key).await;
        results.push(ProviderStatus { id: "groq".into(), label: "Groq STT".into(), ok: valid, message: if valid { "API key valid".into() } else { err.unwrap_or("Invalid".into()) } });
    }

    let dg_key = settings.get(|s| s.deepgram_api_key.clone());
    if !dg_key.is_empty() {
        let (valid, err) = deepgram::validate_api_key(&dg_key).await;
        results.push(ProviderStatus { id: "deepgram".into(), label: "Deepgram STT".into(), ok: valid, message: if valid { "API key valid".into() } else { err.unwrap_or("Invalid".into()) } });
    }

    let oai_key = settings.get(|s| s.openai_api_key.clone());
    if !oai_key.is_empty() {
        let (valid, err) = openai_whisper::validate_api_key(&oai_key).await;
        results.push(ProviderStatus { id: "openai-whisper".into(), label: "OpenAI Whisper".into(), ok: valid, message: if valid { "API key valid".into() } else { err.unwrap_or("Invalid".into()) } });
    }

    let cli_exists = |cmd: &str| -> bool {
        std::process::Command::new("which").arg(cmd).output().map(|o| o.status.success()).unwrap_or(false)
    };

    results.push(ProviderStatus { id: "claude-cli".into(), label: "Claude CLI".into(), ok: cli_exists("claude"), message: if cli_exists("claude") { "Installed".into() } else { "Not found on PATH".into() } });
    results.push(ProviderStatus { id: "codex-cli".into(), label: "Codex CLI".into(), ok: cli_exists("codex"), message: if cli_exists("codex") { "Installed".into() } else { "Not found on PATH".into() } });

    let ollama_endpoint = settings.get(|s| s.ollama_endpoint.clone());
    match reqwest::Client::new().get(format!("{}/api/tags", ollama_endpoint)).timeout(std::time::Duration::from_secs(5)).send().await {
        Ok(resp) if resp.status().is_success() => results.push(ProviderStatus { id: "ollama".into(), label: "Ollama".into(), ok: true, message: "Running".into() }),
        _ => results.push(ProviderStatus { id: "ollama".into(), label: "Ollama".into(), ok: false, message: "Not running".into() }),
    }

    let llama_endpoint = settings.get(|s| s.llama_endpoint.clone());
    match reqwest::Client::new().get(format!("{}/health", llama_endpoint)).timeout(std::time::Duration::from_secs(5)).send().await {
        Ok(resp) if resp.status().is_success() => results.push(ProviderStatus { id: "llama-local".into(), label: "Llama.cpp".into(), ok: true, message: "Running".into() }),
        _ => results.push(ProviderStatus { id: "llama-local".into(), label: "Llama.cpp".into(), ok: false, message: "Not running".into() }),
    }

    results
}
