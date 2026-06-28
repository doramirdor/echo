use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

fn templates_path() -> PathBuf {
    let dir = dirs::home_dir().unwrap_or_default()
        .join("Library/Application Support/echo");
    fs::create_dir_all(&dir).ok();
    dir.join("templates.json")
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DictationTemplate {
    pub id: String,
    pub name: String,
    pub trigger: String,
    pub content: String,
}

#[derive(Clone)]
pub struct TemplateStore {
    templates: Arc<Mutex<Vec<DictationTemplate>>>,
}

impl TemplateStore {
    pub fn new() -> Self {
        let templates = Self::load_from_disk();
        Self { templates: Arc::new(Mutex::new(templates)) }
    }

    fn load_from_disk() -> Vec<DictationTemplate> {
        let path = templates_path();
        if !path.exists() { return vec![]; }
        fs::read_to_string(&path)
            .ok()
            .and_then(|data| serde_json::from_str(&data).ok())
            .unwrap_or_default()
    }

    fn save(&self) {
        let templates = self.templates.lock().unwrap().clone();
        if let Ok(data) = serde_json::to_string_pretty(&templates) {
            let _ = fs::write(templates_path(), data);
        }
    }

    pub fn get_all(&self) -> Vec<DictationTemplate> {
        self.templates.lock().unwrap().clone()
    }

    pub fn add(&self, name: String, trigger: String, content: String) -> DictationTemplate {
        let id = format!("{:x}", chrono::Utc::now().timestamp_millis());
        let entry = DictationTemplate { id, name, trigger, content };
        self.templates.lock().unwrap().push(entry.clone());
        self.save();
        entry
    }

    pub fn remove(&self, id: &str) -> bool {
        let mut templates = self.templates.lock().unwrap();
        let before = templates.len();
        templates.retain(|t| t.id != id);
        if templates.len() < before {
            drop(templates);
            self.save();
            true
        } else {
            false
        }
    }

    pub fn match_trigger(&self, spoken_text: &str) -> Option<DictationTemplate> {
        let lower = spoken_text.to_lowercase();
        self.templates.lock().unwrap().iter()
            .find(|t| lower.contains(&t.trigger.to_lowercase()))
            .cloned()
    }
}
