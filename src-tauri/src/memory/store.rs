use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

/// Context string marking entries added by the vocabulary learner's auto-accept —
/// only these are ever evicted. User-curated entries (any other context) are kept.
pub const AUTO_LEARNED_CONTEXT: &str = "Auto-learned correction";
const MAX_AUTO_LEARNED_ENTRIES: usize = 300;

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
        let mut entries: Vec<MemoryEntry> = fs::read_to_string(&path)
            .ok()
            .and_then(|data| serde_json::from_str(&data).ok())
            .unwrap_or_default();
        Self::prune_auto_learned(&mut entries);
        entries
    }

    /// Cap auto-learned entries so the vocabulary learner cannot grow the store
    /// without bound. Evicts the lowest-`use_count` / oldest-`updated_at` entries
    /// beyond the cap. User-curated vocabulary (any other context) is never evicted.
    /// Returns true if anything was removed.
    fn prune_auto_learned(entries: &mut Vec<MemoryEntry>) -> bool {
        let auto_count = entries.iter().filter(|e| e.context == AUTO_LEARNED_CONTEXT).count();
        if auto_count <= MAX_AUTO_LEARNED_ENTRIES {
            return false;
        }

        // Rank auto-learned entries: lowest use_count first, then oldest updated_at.
        let mut auto: Vec<&MemoryEntry> = entries
            .iter()
            .filter(|e| e.context == AUTO_LEARNED_CONTEXT)
            .collect();
        auto.sort_by(|a, b| {
            a.use_count
                .cmp(&b.use_count)
                .then_with(|| a.updated_at.cmp(&b.updated_at))
        });
        let evict_count = auto_count - MAX_AUTO_LEARNED_ENTRIES;
        let evict_ids: std::collections::HashSet<String> = auto
            .iter()
            .take(evict_count)
            .map(|e| e.id.clone())
            .collect();
        entries.retain(|e| !evict_ids.contains(&e.id));
        log::info!(
            "[memory] Evicted {} auto-learned entries (cap {})",
            evict_count,
            MAX_AUTO_LEARNED_ENTRIES
        );
        true
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
        {
            let mut entries = self.entries.lock().unwrap();
            entries.push(entry.clone());
            Self::prune_auto_learned(&mut entries);
        }
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
