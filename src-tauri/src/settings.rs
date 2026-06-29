use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

fn settings_path() -> PathBuf {
    let dir = dirs::home_dir()
        .unwrap_or_default()
        .join("Library/Application Support/echo");
    fs::create_dir_all(&dir).ok();
    dir.join("settings.json")
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EchoSettings {
    pub hotkey: String,
    pub overlay_hotkey: String,
    pub stt_engine: String,
    pub groq_api_key: String,
    pub deepgram_api_key: String,
    pub openai_api_key: String,
    pub openai_whisper_model: String,
    pub llm_provider: String,
    pub claude_api_key: String,
    pub claude_api_model: String,
    pub openai_api_model: String,
    pub gemini_api_key: String,
    pub gemini_model: String,
    pub bedrock_access_key_id: String,
    pub bedrock_secret_access_key: String,
    pub bedrock_region: String,
    pub bedrock_model: String,
    pub groq_llm_model: String,
    pub ollama_endpoint: String,
    pub ollama_model: String,
    pub llama_endpoint: String,
    pub llama_model: String,
    pub whisper_model_name: String,
    pub open_at_login: bool,
    pub onboarding_complete: bool,
    pub custom_prompt: String,
    pub vocabulary_list: String,
    pub use_window_context: bool,
    pub context_provider: String,
    pub recording_mode: String,
    pub start_delay: u64,
    pub audio_device: String,
    pub custom_prompt_date: String,
    pub grammar_check: bool,
    pub auto_format_content: bool,
    pub silence_detection: bool,
    pub silence_threshold: f64,
    pub silence_duration: u64,
    pub capture_screenshots: bool,
    pub auto_hide_overlay: bool,
    pub transcription_language: String,
    pub app_profiles: HashMap<String, String>,
    pub voice_commands_enabled: bool,
    pub dictation_history_context: u32,
    pub tone: String,
    pub noise_reduction: bool,
    pub whisper_mode: bool,
    pub crash_reporting_enabled: bool,
    pub auto_update_enabled: bool,
}

impl Default for EchoSettings {
    fn default() -> Self {
        Self {
            hotkey: "CommandOrControl+Shift+V".into(),
            overlay_hotkey: "CommandOrControl+Shift+B".into(),
            stt_engine: "whisper".into(),
            groq_api_key: String::new(),
            deepgram_api_key: String::new(),
            openai_api_key: String::new(),
            openai_whisper_model: "whisper-1".into(),
            llm_provider: "claude-cli".into(),
            claude_api_key: String::new(),
            claude_api_model: "claude-sonnet-4-20250514".into(),
            openai_api_model: "gpt-4o-mini".into(),
            gemini_api_key: String::new(),
            gemini_model: "gemini-2.0-flash".into(),
            bedrock_access_key_id: String::new(),
            bedrock_secret_access_key: String::new(),
            bedrock_region: "us-east-1".into(),
            bedrock_model: "anthropic.claude-3-5-haiku-20241022-v1:0".into(),
            groq_llm_model: "llama-3.1-8b-instant".into(),
            ollama_endpoint: "http://localhost:11434".into(),
            ollama_model: "llama3.2".into(),
            llama_endpoint: "http://localhost:8080".into(),
            llama_model: "llama-3.2-3b".into(),
            whisper_model_name: "ggml-small.en.bin".into(),
            open_at_login: false,
            onboarding_complete: false,
            custom_prompt: String::new(),
            vocabulary_list: String::new(),
            use_window_context: true,
            context_provider: "none".into(),
            recording_mode: "toggle".into(),
            start_delay: 0,
            audio_device: String::new(),
            custom_prompt_date: String::new(),
            grammar_check: true,
            auto_format_content: true,
            silence_detection: true,
            silence_threshold: 0.02,
            silence_duration: 2000,
            capture_screenshots: false,
            auto_hide_overlay: false,
            transcription_language: "en".into(),
            app_profiles: HashMap::new(),
            voice_commands_enabled: true,
            dictation_history_context: 2,
            tone: "casual".into(),
            noise_reduction: true,
            whisper_mode: false,
            crash_reporting_enabled: false,
            auto_update_enabled: true,
        }
    }
}

#[derive(Clone)]
pub struct SettingsStore {
    inner: Arc<Mutex<EchoSettings>>,
}

impl SettingsStore {
    pub fn new() -> Self {
        let settings = Self::load_from_disk().unwrap_or_default();
        Self {
            inner: Arc::new(Mutex::new(settings)),
        }
    }

    fn load_from_disk() -> Option<EchoSettings> {
        let path = settings_path();
        if !path.exists() {
            return None;
        }
        let data = fs::read_to_string(&path).ok()?;
        // Merge with defaults so new fields get default values
        let mut defaults = EchoSettings::default();
        if let Ok(saved) = serde_json::from_str::<serde_json::Value>(&data) {
            if let Ok(merged) = serde_json::to_string(&defaults) {
                let mut base: serde_json::Value = serde_json::from_str(&merged).unwrap_or_default();
                if let serde_json::Value::Object(ref mut map) = base {
                    if let serde_json::Value::Object(saved_map) = saved {
                        for (k, v) in saved_map {
                            map.insert(k, v);
                        }
                    }
                }
                if let Ok(s) = serde_json::from_value(base) {
                    defaults = s;
                }
            }
        }
        Some(defaults)
    }

    fn save_to_disk(&self) {
        let settings = self.inner.lock().unwrap().clone();
        let path = settings_path();
        if let Ok(data) = serde_json::to_string_pretty(&settings) {
            let _ = fs::write(path, data);
        }
    }

    pub fn get_all(&self) -> EchoSettings {
        self.inner.lock().unwrap().clone()
    }

    pub fn get<F, R>(&self, f: F) -> R
    where
        F: FnOnce(&EchoSettings) -> R,
    {
        let settings = self.inner.lock().unwrap();
        f(&settings)
    }

    pub fn set_value(&self, key: &str, value: serde_json::Value) {
        {
            let mut settings = self.inner.lock().unwrap();
            let mut json = serde_json::to_value(&*settings).unwrap_or_default();
            if let serde_json::Value::Object(ref mut map) = json {
                map.insert(key.to_string(), value);
            }
            if let Ok(updated) = serde_json::from_value(json) {
                *settings = updated;
            }
        }
        self.save_to_disk();
    }
}
