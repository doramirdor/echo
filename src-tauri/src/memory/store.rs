use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

fn memory_path() -> PathBuf {
    let dir = dirs::home_dir().unwrap_or_default()
        .join("Library/Application Support/echo");
    fs::create_dir_all(&dir).ok();
    dir.join("memory.json")
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryEntry {
    pub id: String,
    pub term: String,
    pub context: String,
    pub misrecognitions: Vec<String>,
    pub category: String,
    pub use_count: u32,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Clone)]
pub struct MemoryStore {
    entries: Arc<Mutex<Vec<MemoryEntry>>>,
}

impl MemoryStore {
    pub fn new() -> Self {
        let entries = Self::load_from_disk();
        Self { entries: Arc::new(Mutex::new(entries)) }
    }

    fn load_from_disk() -> Vec<MemoryEntry> {
        let path = memory_path();
        if !path.exists() { return vec![]; }
        fs::read_to_string(&path)
            .ok()
            .and_then(|data| serde_json::from_str(&data).ok())
            .unwrap_or_default()
    }

    fn save(&self) {
        let entries = self.entries.lock().unwrap().clone();
        let path = memory_path();
        if let Ok(data) = serde_json::to_string_pretty(&entries) {
            let _ = fs::write(path, data);
        }
    }

    pub fn get_all(&self) -> Vec<MemoryEntry> {
        self.entries.lock().unwrap().clone()
    }

    pub fn add(&self, term: String, context: String, misrecognitions: Vec<String>, category: String) -> MemoryEntry {
        let now = chrono::Utc::now().to_rfc3339();
        let entry = MemoryEntry {
            id: uuid::Uuid::new_v4().to_string(),
            term, context, misrecognitions, category,
            use_count: 0,
            created_at: now.clone(),
            updated_at: now,
        };
        self.entries.lock().unwrap().push(entry.clone());
        self.save();
        entry
    }

    pub fn remove(&self, id: &str) -> bool {
        let mut entries = self.entries.lock().unwrap();
        let before = entries.len();
        entries.retain(|e| e.id != id);
        if entries.len() < before {
            drop(entries);
            self.save();
            true
        } else {
            false
        }
    }

    pub fn find_relevant(&self, text: &str) -> Vec<MemoryEntry> {
        let lower = text.to_lowercase();
        self.entries.lock().unwrap().iter()
            .filter(|e| {
                e.misrecognitions.iter().any(|m| lower.contains(&m.to_lowercase()))
                    || lower.contains(&e.term.to_lowercase())
            })
            .cloned()
            .collect()
    }

    pub fn format_for_prompt(&self, entries: &[MemoryEntry]) -> String {
        if entries.is_empty() { return String::new(); }
        entries.iter()
            .map(|e| {
                let mis = if !e.misrecognitions.is_empty() {
                    format!(" (NOT \"{}\")", e.misrecognitions.join("\", \""))
                } else {
                    String::new()
                };
                format!("- \"{}\" - {}{}", e.term, e.context, mis)
            })
            .collect::<Vec<_>>()
            .join("\n")
    }

    pub fn mark_used(&self, ids: &[String]) {
        let mut entries = self.entries.lock().unwrap();
        for id in ids {
            if let Some(e) = entries.iter_mut().find(|e| &e.id == id) {
                e.use_count += 1;
                e.updated_at = chrono::Utc::now().to_rfc3339();
            }
        }
        drop(entries);
        self.save();
    }

    pub fn flush(&self) {
        self.save();
    }
}
