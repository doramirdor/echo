// Learns from the edits a user makes to inserted text.
//
// After Echo inserts refined text, the user often tweaks it by hand ("Claude"
// where Echo wrote "cloud", "use" where it wrote "utilise"…). The next time they
// dictate into the same field, `learn_from_field()` re-reads the field, re-locates
// what Echo had inserted, and diffs it against the edited version. Recurring
// substitutions are remembered and fed back to the refiner as preferences.
//
// Sibling of the vocabulary learner (memory::vocabulary): that one learns STT
// misrecognitions (raw → refined), this one learns the user's own corrections
// (refined → hand-edited). Corrections are applied as REFINER CONTEXT only.
// Mirrors src/main/memory/editLearner.ts.

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

// A correction must recur this many times before Echo trusts it enough to feed
// back to the refiner. Edits are high-signal (the user deliberately changed the
// text), so this is lower than the vocabulary learner's raw→refined threshold.
const AUTO_ACCEPT_THRESHOLD: u32 = 2;
const MAX_STORED: usize = 200; // cap the store; evict lowest-count/oldest beyond this
const MAX_PROMPT_ENTRIES: usize = 20; // cap how many corrections we feed the refiner
const MAX_SPAN_WORDS: usize = 6; // ignore edits longer than this on either side
const MIN_SIMILARITY: f64 = 0.4; // below this the edit replaced too much to be a targeted correction

fn corrections_path() -> PathBuf {
    // ECHO_SUPPORT_DIR overrides the support directory. The unit tests set it to a
    // temp dir so `save()` never overwrites the user's real edit-corrections.json;
    // it's also a handy escape hatch for a portable/relocated install.
    let dir = match std::env::var("ECHO_SUPPORT_DIR") {
        Ok(d) if !d.is_empty() => PathBuf::from(d),
        _ => dirs::home_dir()
            .unwrap_or_default()
            .join("Library/Application Support/echo"),
    };
    fs::create_dir_all(&dir).ok();
    dir.join("edit-corrections.json")
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EditCorrection {
    pub from: String,
    pub to: String,
    pub count: u32,
    pub created_at: String,
    pub updated_at: String,
}

/// A snapshot of the last text Echo inserted, so the next read can re-locate it.
#[derive(Clone)]
struct PendingInsertion {
    inserted: String,
    before_anchor: String,
    after_anchor: String,
}

/// Arc-backed so clones share one underlying state — the record-start task and
/// the pipeline task both hold clones and must see the same corrections/pending.
#[derive(Clone)]
pub struct EditLearner {
    corrections: Arc<Mutex<Vec<EditCorrection>>>,
    pending: Arc<Mutex<Option<PendingInsertion>>>,
}

impl EditLearner {
    pub fn new() -> Self {
        Self {
            corrections: Arc::new(Mutex::new(Self::load_from_disk())),
            pending: Arc::new(Mutex::new(None)),
        }
    }

    /// Snapshot the text just inserted (and its surrounding field context) so the
    /// next dictation can detect how the user edited it. Overwrites any prior
    /// pending snapshot — we only track the most recent insertion.
    pub fn record_insertion(&self, inserted: &str, before_anchor: &str, after_anchor: &str) {
        let mut pending = self.pending.lock().unwrap();
        if inserted.trim().is_empty() {
            *pending = None;
            return;
        }
        *pending = Some(PendingInsertion {
            inserted: inserted.to_string(),
            before_anchor: before_anchor.to_string(),
            after_anchor: after_anchor.to_string(),
        });
    }

    /// Called at the start of the next dictation with a fresh read of the focused
    /// field. If the previously inserted text is still locatable and was edited,
    /// learn the substitution(s). Consumes the pending snapshot unconditionally:
    /// detection gets exactly one shot, at the next dictation.
    pub fn learn_from_field(&self, before: &str, after: &str) {
        let pending = self.pending.lock().unwrap().take();
        let Some(p) = pending else {
            return;
        };

        let full_now = format!("{}{}", before, after);

        // Re-locate our inserted region by stripping the (unchanged) surrounding
        // text. If the surroundings changed — different field/app, or the user
        // restructured around it — bail rather than risk learning noise. Because
        // the anchors are a verified prefix/suffix, their byte lengths land on
        // char boundaries, so the slice below is safe.
        if !full_now.starts_with(&p.before_anchor) || !full_now.ends_with(&p.after_anchor) {
            return;
        }
        let start = p.before_anchor.len();
        let end = full_now.len().saturating_sub(p.after_anchor.len());
        if end < start {
            return;
        }
        let edited_region = &full_now[start..end];

        if normalize(edited_region) == normalize(&p.inserted) {
            return; // untouched
        }

        // extract_substitutions applies the similarity guard: a wholesale rewrite
        // (user replaced everything / dictated something unrelated) yields nothing.
        let subs = extract_substitutions(&p.inserted, edited_region);
        if subs.is_empty() {
            return;
        }

        let mut changed = false;
        for (f, t) in subs {
            if self.record(&f, &t) {
                changed = true;
            }
        }
        if changed {
            self.save();
        }
    }

    /// Format the trusted corrections (seen ≥ threshold) for the refiner prompt.
    /// Empty string when there's nothing confident to add.
    pub fn format_for_prompt(&self) -> String {
        let mut active: Vec<EditCorrection> = self
            .corrections
            .lock()
            .unwrap()
            .iter()
            .filter(|c| c.count >= AUTO_ACCEPT_THRESHOLD)
            .cloned()
            .collect();
        active.sort_by(|a, b| b.count.cmp(&a.count).then(b.updated_at.cmp(&a.updated_at)));
        active.truncate(MAX_PROMPT_ENTRIES);
        if active.is_empty() {
            return String::new();
        }
        active
            .iter()
            .map(|c| format!("- \"{}\" → \"{}\"", c.from, c.to))
            .collect::<Vec<_>>()
            .join("\n")
    }

    /// Record one substitution, tallying repeats. Returns true if stored/updated.
    fn record(&self, from: &str, to: &str) -> bool {
        let f = from.trim();
        let t = to.trim();
        if f.is_empty() || t.is_empty() {
            return false;
        }
        if strip_punct(f) == strip_punct(t) {
            return false; // pure punctuation/casing churn — not a correction
        }

        let now = chrono::Utc::now().to_rfc3339();
        let mut list = self.corrections.lock().unwrap();

        // If the user just reversed a previously-learned correction (edited Y back
        // to X), drop the stale forward rule so we don't fight them.
        list.retain(|c| !(eq(&c.from, t) && eq(&c.to, f)));

        if let Some(e) = list.iter_mut().find(|c| eq(&c.from, f) && eq(&c.to, t)) {
            e.count += 1;
            e.updated_at = now;
            log::info!("[edit-learner] \"{}\" → \"{}\" (seen {}x)", f, t, e.count);
            return true;
        }

        list.push(EditCorrection {
            from: f.to_string(),
            to: t.to_string(),
            count: 1,
            created_at: now.clone(),
            updated_at: now,
        });
        if list.len() > MAX_STORED {
            list.sort_by(|a, b| b.count.cmp(&a.count).then(b.updated_at.cmp(&a.updated_at)));
            list.truncate(MAX_STORED);
        }
        log::info!("[edit-learner] New \"{}\" → \"{}\"", f, t);
        true
    }

    fn load_from_disk() -> Vec<EditCorrection> {
        let path = corrections_path();
        if !path.exists() {
            return vec![];
        }
        fs::read_to_string(&path)
            .ok()
            .and_then(|data| serde_json::from_str(&data).ok())
            .unwrap_or_default()
    }

    fn save(&self) {
        let entries = self.corrections.lock().unwrap().clone();
        if let Ok(data) = serde_json::to_string_pretty(&entries) {
            let _ = fs::write(corrections_path(), data);
        }
    }
}

fn normalize(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ").to_lowercase()
}

fn strip_punct(s: &str) -> String {
    s.to_lowercase().chars().filter(|c| c.is_alphanumeric()).collect()
}

fn eq(a: &str, b: &str) -> bool {
    a.to_lowercase() == b.to_lowercase()
}

/// Word-level diff between the text Echo inserted and the user's edited version,
/// returning only the substituted spans as `(from, to)` pairs.
///
/// Uses an LCS alignment: matched words anchor the diff, and each run of unmatched
/// words on both sides becomes one substitution. Pure insertions and pure
/// deletions are skipped. A wholesale rewrite — LCS similarity below
/// `MIN_SIMILARITY` — returns nothing. Mirrors extractSubstitutions in
/// src/main/memory/editLearner.ts.
pub fn extract_substitutions(before: &str, after: &str) -> Vec<(String, String)> {
    let a: Vec<&str> = before.split_whitespace().collect();
    let b: Vec<&str> = after.split_whitespace().collect();
    if a.is_empty() || b.is_empty() {
        return vec![];
    }

    let n = a.len();
    let m = b.len();
    let mut dp = vec![vec![0usize; m + 1]; n + 1];
    for i in (0..n).rev() {
        for j in (0..m).rev() {
            dp[i][j] = if a[i].to_lowercase() == b[j].to_lowercase() {
                dp[i + 1][j + 1] + 1
            } else {
                dp[i + 1][j].max(dp[i][j + 1])
            };
        }
    }

    // Reject wholesale rewrites — the user replaced the text rather than
    // correcting a word. Exception: a very short (≤2-word) field can legitimately
    // be swapped in full ("cloud" → "Claude"), where there's no surrounding
    // context to share; there the recurrence threshold provides the precision.
    let similarity = (2.0 * dp[0][0] as f64) / (n + m) as f64;
    let short_enough = n.min(m) <= 2;
    if similarity < MIN_SIMILARITY && !short_enough {
        return vec![];
    }

    let mut subs: Vec<(String, String)> = Vec::new();
    let mut from_run: Vec<&str> = Vec::new();
    let mut to_run: Vec<&str> = Vec::new();
    macro_rules! flush {
        () => {{
            if !from_run.is_empty()
                && !to_run.is_empty()
                && from_run.len() <= MAX_SPAN_WORDS
                && to_run.len() <= MAX_SPAN_WORDS
            {
                subs.push((from_run.join(" "), to_run.join(" ")));
            }
            from_run.clear();
            to_run.clear();
        }};
    }

    let (mut i, mut j) = (0usize, 0usize);
    while i < n && j < m {
        if a[i].to_lowercase() == b[j].to_lowercase() {
            flush!();
            i += 1;
            j += 1;
        } else if dp[i + 1][j] >= dp[i][j + 1] {
            from_run.push(a[i]);
            i += 1;
        } else {
            to_run.push(b[j]);
            j += 1;
        }
    }
    while i < n {
        from_run.push(a[i]);
        i += 1;
    }
    while j < m {
        to_run.push(b[j]);
        j += 1;
    }
    flush!();

    subs
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_single_word_substitution() {
        let subs = extract_substitutions("let's ask the cloud model", "let's ask the Claude model");
        assert_eq!(subs, vec![("cloud".to_string(), "Claude".to_string())]);
    }

    #[test]
    fn learns_isolated_single_word_swap() {
        // A one-word field replaced in full has no shared context, but is still a
        // legitimate correction — allowed because both sides are ≤2 words.
        let subs = extract_substitutions("cloud", "Claude");
        assert_eq!(subs, vec![("cloud".to_string(), "Claude".to_string())]);
    }

    #[test]
    fn ignores_wholesale_rewrite() {
        let subs = extract_substitutions("the quick brown fox", "entirely different sentence here now");
        assert!(subs.is_empty());
    }

    #[test]
    fn no_change_yields_nothing() {
        assert!(extract_substitutions("same text here", "same text here").is_empty());
    }

    #[test]
    fn learns_after_threshold() {
        let learner = empty_learner();
        // First correction: recorded but not yet trusted.
        learner.record_insertion("call the cloud", "", "");
        learner.learn_from_field("call the Claude", "");
        assert_eq!(learner.format_for_prompt(), "");
        // Second time: crosses the threshold and is offered to the refiner.
        learner.record_insertion("call the cloud", "", "");
        learner.learn_from_field("call the Claude", "");
        assert_eq!(learner.format_for_prompt(), "- \"cloud\" → \"Claude\"");
    }

    /// Redirect the support dir to a per-binary temp dir the first time any test
    /// runs, so `save()` (reached via record_insertion/learn_from_field) never
    /// clobbers the user's real edit-corrections.json. Set once and left set for
    /// the whole test binary, which is safe under parallel test threads.
    fn redirect_support_dir() {
        static ONCE: std::sync::Once = std::sync::Once::new();
        ONCE.call_once(|| {
            let dir = std::env::temp_dir().join("echo-edit-learner-tests");
            let _ = fs::create_dir_all(&dir);
            std::env::set_var("ECHO_SUPPORT_DIR", &dir);
            // Start from a clean slate so a stale file from a prior run can't leak in.
            let _ = fs::remove_file(dir.join("edit-corrections.json"));
        });
    }

    /// A learner with an empty in-memory store, bypassing `load_from_disk` so the
    /// test doesn't pick up the user's real edit-corrections.json. (Mirrors the
    /// `fs`-mock the TypeScript suite installs.)
    fn empty_learner() -> EditLearner {
        redirect_support_dir();
        EditLearner {
            corrections: Arc::new(Mutex::new(vec![])),
            pending: Arc::new(Mutex::new(None)),
        }
    }

    #[test]
    fn extracts_multi_word_substitution() {
        let subs = extract_substitutions("meet on monday please", "meet on tuesday morning please");
        assert_eq!(subs, vec![("monday".to_string(), "tuesday morning".to_string())]);
    }

    #[test]
    fn ignores_pure_insertions_and_deletions() {
        // Appended a clause — no substitution span (both-sided), so nothing to learn.
        assert!(extract_substitutions("call me later", "call me later today please").is_empty());
        // Removed a word — likewise.
        assert!(extract_substitutions("call me later today", "call me later").is_empty());
    }

    #[test]
    fn captures_multiple_substitutions() {
        let subs = extract_substitutions("the cat sat on the mat", "the dog sat on the rug");
        assert_eq!(
            subs,
            vec![
                ("cat".to_string(), "dog".to_string()),
                ("mat".to_string(), "rug".to_string()),
            ]
        );
    }

    #[test]
    fn relocates_edit_using_surrounding_field_text() {
        let learner = empty_learner();
        let before = "Hey team, ";
        let after = " by friday.";
        for _ in 0..2 {
            learner.record_insertion("ship the featur", before, after);
            // The user's field now reads before + edited + after.
            learner.learn_from_field(&format!("{}{}", before, "ship the feature"), after);
        }
        assert_eq!(learner.format_for_prompt(), "- \"featur\" → \"feature\"");
    }

    #[test]
    fn does_not_learn_when_surroundings_change() {
        let learner = empty_learner();
        for _ in 0..2 {
            learner.record_insertion("call the cloud", "A ", "");
            // Prefix "A " is missing from the field now — can't re-locate, so bail.
            learner.learn_from_field("B call the Claude", "");
        }
        assert_eq!(learner.format_for_prompt(), "");
    }

    #[test]
    fn ignores_untouched_insertion() {
        let learner = empty_learner();
        for _ in 0..2 {
            learner.record_insertion("perfect as is", "", "");
            learner.learn_from_field("perfect as is", "");
        }
        assert_eq!(learner.format_for_prompt(), "");
        assert_eq!(learner.corrections.lock().unwrap().len(), 0);
    }

    #[test]
    fn consumes_pending_snapshot() {
        let learner = empty_learner();
        learner.record_insertion("call the cloud", "", "");
        learner.learn_from_field("call the Claude", "");
        // No new record_insertion: the pending snapshot is already spent, so a
        // second read cannot double-learn.
        learner.learn_from_field("call the Claude", "");
        let list = learner.corrections.lock().unwrap();
        let entry = list.iter().find(|c| c.from.to_lowercase() == "cloud");
        assert_eq!(entry.map(|c| c.count), Some(1));
    }

    #[test]
    fn drops_forward_rule_when_reversed() {
        let learner = empty_learner();
        for _ in 0..2 {
            learner.record_insertion("call the cloud", "", "");
            learner.learn_from_field("call the Claude", "");
        }
        assert_eq!(learner.format_for_prompt(), "- \"cloud\" → \"Claude\"");

        // User changes their mind and edits "Claude" back to "cloud".
        learner.record_insertion("ping the Claude", "", "");
        learner.learn_from_field("ping the cloud", "");
        assert_eq!(learner.format_for_prompt(), "");
    }

    #[test]
    fn ignores_punctuation_and_casing_edits() {
        let learner = empty_learner();
        for _ in 0..2 {
            learner.record_insertion("hello world", "", "");
            learner.learn_from_field("hello world.", "");
        }
        assert_eq!(learner.corrections.lock().unwrap().len(), 0);
    }
}
