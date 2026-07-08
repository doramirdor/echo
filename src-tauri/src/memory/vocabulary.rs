// Vocabulary learner — auto-learns corrections from raw vs refined diffs.
// Mirrors src/main/memory/vocabularyLearner.ts: a correction seen
// AUTO_ACCEPT_THRESHOLD times is added to memory automatically.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

use super::store::{MemoryStore, AUTO_LEARNED_CONTEXT};

const AUTO_ACCEPT_THRESHOLD: u32 = 3;
const MAX_SUGGESTIONS: usize = 500;
/// Below this length a 2-char difference is most of the word, so fuzzy matching is noise.
const MIN_FUZZY_WORD_LENGTH: usize = 4;

/// Process-wide tally of `"misrecognition->term"` → count, so a correction must
/// recur before it's trusted enough to persist.
fn suggestion_counts() -> &'static Mutex<HashMap<String, u32>> {
    static COUNTS: OnceLock<Mutex<HashMap<String, u32>>> = OnceLock::new();
    COUNTS.get_or_init(|| Mutex::new(HashMap::new()))
}

pub fn analyze_and_learn(memory: &MemoryStore, raw: &str, refined: &str) {
    if raw.to_lowercase() == refined.to_lowercase() {
        return;
    }

    let raw_words: Vec<&str> = raw.split_whitespace().collect();
    let refined_words: Vec<&str> = refined.split_whitespace().collect();

    for rw in &refined_words {
        if rw.chars().count() < 2 {
            continue;
        }
        // Same word already present verbatim → nothing to learn.
        if raw_words.iter().any(|w| w == rw) {
            continue;
        }

        for raw_word in &raw_words {
            if raw_word == rw {
                continue;
            }
            let is_case_variant = raw_word.to_lowercase() == rw.to_lowercase();
            // Very short raw words (a, the, to...) produce garbage fuzzy matches;
            // only pure case corrections are worth keeping for them.
            if !is_case_variant && raw_word.chars().count() < MIN_FUZZY_WORD_LENGTH {
                continue;
            }
            if is_case_variant || sounds_similar(raw_word, rw) {
                let key = format!("{}->{}", raw_word.to_lowercase(), rw);
                let count = {
                    let mut counts = suggestion_counts().lock().unwrap();
                    let c = counts.entry(key.clone()).or_insert(0);
                    *c += 1;
                    *c
                };
                log::info!("[vocab-learner] Correction \"{}\" -> \"{}\" (seen {}x)", raw_word, rw, count);

                if count >= AUTO_ACCEPT_THRESHOLD {
                    auto_accept(memory, rw, raw_word);
                    suggestion_counts().lock().unwrap().remove(&key);
                }
            }
        }
    }

    prune_suggestions();
}

/// Keep the suggestions tally bounded; evict the lowest-count entries first.
fn prune_suggestions() {
    let mut counts = suggestion_counts().lock().unwrap();
    if counts.len() <= MAX_SUGGESTIONS {
        return;
    }
    let mut by_count: Vec<(String, u32)> = counts.iter().map(|(k, v)| (k.clone(), *v)).collect();
    by_count.sort_by(|a, b| a.1.cmp(&b.1));
    let excess = counts.len() - MAX_SUGGESTIONS;
    for (key, _) in by_count.into_iter().take(excess) {
        counts.remove(&key);
    }
}

/// Persist a confident correction into memory, unless the misrecognition is
/// already recorded somewhere.
fn auto_accept(memory: &MemoryStore, term: &str, misrecognition: &str) {
    let already = memory.get_all().iter().any(|e| {
        e.misrecognitions
            .iter()
            .any(|m| m.to_lowercase() == misrecognition.to_lowercase())
    });
    if already {
        return;
    }
    memory.add(
        term.to_string(),
        AUTO_LEARNED_CONTEXT.to_string(),
        vec![misrecognition.to_string()],
        "productName".to_string(),
    );
    log::info!("[vocab-learner] Auto-accepted: \"{}\" -> \"{}\"", misrecognition, term);
}

fn sounds_similar(a: &str, b: &str) -> bool {
    let al = a.to_lowercase();
    let bl = b.to_lowercase();
    if al == bl {
        return true;
    }
    // Only fuzzy-match words long enough that a 2-char difference is plausibly
    // the same word.
    if al.chars().count().min(bl.chars().count()) < MIN_FUZZY_WORD_LENGTH {
        return false;
    }
    if (al.len() as isize - bl.len() as isize).unsigned_abs() <= 1 {
        let max_len = al.len().max(bl.len());
        let diffs: usize = al.chars().zip(bl.chars()).filter(|(a, b)| a != b).count()
            + max_len.saturating_sub(al.len().min(bl.len()));
        return diffs <= 2;
    }
    false
}
