use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

const MAX_ENTRIES: usize = 100;

fn log_path() -> PathBuf {
    let dir = dirs::home_dir().unwrap_or_default()
        .join("Library/Application Support/echo");
    fs::create_dir_all(&dir).ok();
    dir.join("run-log.json")
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunLogEntry {
    pub id: String,
    pub timestamp: String,
    pub raw_transcription: String,
    pub refined_text: String,
    pub context: String,
    pub stt_engine: String,
    pub llm_provider: String,
    pub duration_ms: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Clone)]
pub struct RunLog {
    entries: Arc<Mutex<Vec<RunLogEntry>>>,
}

impl RunLog {
    pub fn new() -> Self {
        let entries = Self::load_from_disk();
        Self { entries: Arc::new(Mutex::new(entries)) }
    }

    fn load_from_disk() -> Vec<RunLogEntry> {
        let path = log_path();
        if !path.exists() { return vec![]; }
        fs::read_to_string(&path)
            .ok()
            .and_then(|data| serde_json::from_str(&data).ok())
            .unwrap_or_default()
    }

    fn save(&self) {
        let entries = self.entries.lock().unwrap().clone();
        if let Ok(data) = serde_json::to_string_pretty(&entries) {
            let _ = fs::write(log_path(), data);
        }
    }

    pub fn add(&self, raw: String, refined: String, context: String, stt: String, llm: String, duration_ms: u64, error: Option<String>) -> RunLogEntry {
        let id = format!("{}{}", chrono::Utc::now().timestamp_millis(), &uuid::Uuid::new_v4().to_string()[..4]);
        let entry = RunLogEntry {
            id,
            timestamp: chrono::Utc::now().to_rfc3339(),
            raw_transcription: raw,
            refined_text: refined,
            context,
            stt_engine: stt,
            llm_provider: llm,
            duration_ms,
            error,
        };
        let mut entries = self.entries.lock().unwrap();
        entries.insert(0, entry.clone());
        if entries.len() > MAX_ENTRIES {
            entries.truncate(MAX_ENTRIES);
        }
        drop(entries);
        self.save();
        entry
    }

    pub fn get_all(&self) -> Vec<RunLogEntry> {
        self.entries.lock().unwrap().clone()
    }

    pub fn clear(&self) {
        self.entries.lock().unwrap().clear();
        self.save();
    }

    pub fn search(&self, query: &str) -> Vec<RunLogEntry> {
        let lower = query.to_lowercase();
        self.entries.lock().unwrap().iter()
            .filter(|e| e.raw_transcription.to_lowercase().contains(&lower)
                || e.refined_text.to_lowercase().contains(&lower))
            .cloned()
            .collect()
    }
}
