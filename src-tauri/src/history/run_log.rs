use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

// The run log is the only source the Insights tab aggregates over, so this cap
// is also the horizon of every all-time stat (total words, longest streak,
// month-over-month growth). 100 was low enough that a few weeks of daily use
// silently started erasing history; entries are ~500 bytes, so 1000 costs well
// under a megabyte.
const MAX_ENTRIES: usize = 1000;

fn log_path() -> PathBuf {
    // ECHO_SUPPORT_DIR overrides the support directory (same seam as
    // edit_learner.rs) so the unit tests can exercise add()/clear() against a
    // temp dir instead of clobbering the user's real run-log.json.
    let dir = match std::env::var("ECHO_SUPPORT_DIR") {
        Ok(d) if !d.is_empty() => PathBuf::from(d),
        _ => dirs::home_dir()
            .unwrap_or_default()
            .join("Library/Application Support/echo"),
    };
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_app: Option<String>,
    pub stt_engine: String,
    pub llm_provider: String,
    /// Wall-clock time the *pipeline* took (transcribe + refine + insert).
    pub duration_ms: u64,
    /// How long the user actually spoke, derived from the recorded WAV. This —
    /// not `duration_ms` — is what words-per-minute must be computed against.
    /// `None` on entries written before the field existed, and on runs that
    /// failed before a WAV was produced.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub speech_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// One pipeline run, as handed to [`RunLog::add`]. A struct rather than a long
/// positional argument list so the several same-typed `String` fields can't be
/// transposed at a call site.
#[derive(Debug, Clone, Default)]
pub struct NewRun {
    pub raw: String,
    pub refined: String,
    pub context: String,
    pub source_app: Option<String>,
    pub stt_engine: String,
    pub llm_provider: String,
    pub duration_ms: u64,
    pub speech_ms: Option<u64>,
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

    /// In-memory RunLog seeded with the given entries (newest first), bypassing
    /// disk entirely. Test-only: lets the stats suite build a history without
    /// reading or writing run-log.json.
    #[cfg(test)]
    pub fn from_entries(entries: Vec<RunLogEntry>) -> Self {
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

    pub fn add(&self, run: NewRun) -> RunLogEntry {
        let id = format!("{}{}", chrono::Utc::now().timestamp_millis(), &uuid::Uuid::new_v4().to_string()[..4]);
        let entry = RunLogEntry {
            id,
            timestamp: chrono::Utc::now().to_rfc3339(),
            raw_transcription: run.raw,
            refined_text: run.refined,
            context: run.context,
            source_app: run.source_app,
            stt_engine: run.stt_engine,
            llm_provider: run.llm_provider,
            duration_ms: run.duration_ms,
            speech_ms: run.speech_ms,
            error: run.error,
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    // Ported from tests/runLog.test.ts.
    //
    // DISK SAFETY: `add()` and `clear()` both call `save()`, which writes to
    // `log_path()`. Every test that touches them must call
    // `redirect_support_dir()` first so ECHO_SUPPORT_DIR points at a temp dir
    // and the user's real run-log.json is never clobbered.

    /// Redirect the support dir to a temp dir the first time any test runs, so
    /// `save()` never clobbers the user's real run-log.json. Set once and left
    /// set for the whole test binary, which is safe under parallel test threads
    /// (mirrors `edit_learner::tests::redirect_support_dir`; whichever module
    /// wins the race, the destination is a temp dir either way).
    fn redirect_support_dir() {
        static ONCE: std::sync::Once = std::sync::Once::new();
        ONCE.call_once(|| {
            let dir = std::env::temp_dir().join("echo-run-log-tests");
            let _ = fs::create_dir_all(&dir);
            std::env::set_var("ECHO_SUPPORT_DIR", &dir);
        });
    }

    /// A RunLog with an empty in-memory store, bypassing `load_from_disk` so the
    /// test doesn't pick up whatever run-log.json happens to be on disk.
    fn empty_log() -> RunLog {
        redirect_support_dir();
        seeded(vec![])
    }

    /// Build a RunLog seeded with in-memory entries WITHOUT touching disk
    /// (does not call new()/add()/save(), so the real run-log.json is untouched).
    fn seeded(entries: Vec<RunLogEntry>) -> RunLog {
        RunLog { entries: Arc::new(Mutex::new(entries)) }
    }

    fn make_entry(raw: &str, refined: &str, stt: &str, llm: &str, duration_ms: u64) -> RunLogEntry {
        RunLogEntry {
            id: String::new(),
            timestamp: String::new(),
            raw_transcription: raw.to_string(),
            refined_text: refined.to_string(),
            context: String::new(),
            source_app: None,
            stt_engine: stt.to_string(),
            llm_provider: llm.to_string(),
            duration_ms,
            speech_ms: None,
            error: None,
        }
    }

    fn new_run(raw: &str, refined: &str) -> NewRun {
        NewRun {
            raw: raw.to_string(),
            refined: refined.to_string(),
            stt_engine: "whisper".into(),
            llm_provider: "none".into(),
            duration_ms: 100,
            ..Default::default()
        }
    }

    // Ports "searches entries" from tests/runLog.test.ts.
    // Exercises the real `search()` method; entries are seeded in memory
    // (in place of add()) to keep the test disk-safe.
    #[test]
    fn searches_entries() {
        let run_log = seeded(vec![
            make_entry("react component", "React component.", "whisper", "claude-cli", 200),
            make_entry("hello world", "Hello world.", "groq", "none", 100),
        ]);

        let results = run_log.search("react");
        assert_eq!(results.len(), 1);
        assert!(results[0].refined_text.contains("React"));
    }

    // Ports "adds entries" from tests/runLog.test.ts.
    #[test]
    fn adds_entries_newest_first() {
        let run_log = empty_log();
        run_log.add(new_run("first", "First."));
        run_log.add(new_run("second", "Second."));

        let all = run_log.get_all();
        assert_eq!(all.len(), 2);
        // add() inserts at the head, so the newest run is index 0 — the order the
        // History tab and `recentDictations` both rely on.
        assert_eq!(all[0].raw_transcription, "second");
        assert_eq!(all[1].raw_transcription, "first");
        assert!(!all[0].id.is_empty());
        assert!(!all[0].timestamp.is_empty());
    }

    // Ports "caps at MAX_ENTRIES" from tests/runLog.test.ts.
    #[test]
    fn caps_at_max_entries() {
        let run_log = empty_log();
        for i in 0..(MAX_ENTRIES + 10) {
            run_log.add(new_run(&format!("run {}", i), "x"));
        }

        let all = run_log.get_all();
        assert_eq!(all.len(), MAX_ENTRIES);
        // The oldest runs are the ones dropped, not the newest.
        assert_eq!(all[0].raw_transcription, format!("run {}", MAX_ENTRIES + 9));
    }

    // Ports "clears all entries" from tests/runLog.test.ts.
    #[test]
    fn clears_all_entries() {
        let run_log = empty_log();
        run_log.add(new_run("hello", "Hello."));
        assert_eq!(run_log.get_all().len(), 1);

        run_log.clear();
        assert!(run_log.get_all().is_empty());
    }

    // `get_run_log` is a thin `serde_json::to_value(get_all())`, so the JSON keys
    // here ARE the renderer's contract. settings.js reads these names off each
    // entry (renderHistory / diffWords); renaming a field in Rust without
    // updating the renderer would silently blank out the History tab.
    #[test]
    fn serializes_the_field_names_the_renderer_reads() {
        let run_log = empty_log();
        run_log.add(NewRun {
            raw: "hello".into(),
            refined: "Hello.".into(),
            source_app: Some("Cursor".into()),
            stt_engine: "whisper".into(),
            llm_provider: "groq".into(),
            duration_ms: 2_700,
            speech_ms: Some(4_000),
            ..Default::default()
        });

        let json = serde_json::to_value(run_log.get_all()).unwrap();
        let entry = &json[0];
        for key in [
            "id", "timestamp", "rawTranscription", "refinedText", "context",
            "sourceApp", "sttEngine", "llmProvider", "durationMs", "speechMs",
        ] {
            assert!(!entry[key].is_null(), "missing key {} in {}", key, entry);
        }
        assert_eq!(entry["durationMs"], 2_700);
        assert_eq!(entry["speechMs"], 4_000);
        // `error` is skipped when absent — the renderer branches on its presence.
        assert!(entry.get("error").is_none());
    }

    // Old run-log.json files predate `speechMs`; they must still deserialize
    // (as None) rather than wiping the user's entire history.
    #[test]
    fn deserializes_entries_without_speech_ms() {
        let json = r#"[{
            "id": "1",
            "timestamp": "2026-07-31T14:34:40.804662+00:00",
            "rawTranscription": "hello",
            "refinedText": "Hello.",
            "context": "",
            "sttEngine": "whisper",
            "llmProvider": "groq",
            "durationMs": 2700
        }]"#;
        let entries: Vec<RunLogEntry> = serde_json::from_str(json).expect("legacy entry should parse");
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].speech_ms, None);
        assert_eq!(entries[0].refined_text, "Hello.");
    }
}
