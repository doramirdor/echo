// Vocabulary learner — auto-learns corrections from raw vs refined diffs.
// Mirrors src/main/memory/vocabularyLearner.ts: a correction seen
// AUTO_ACCEPT_THRESHOLD times is added to memory automatically.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

use super::store::MemoryStore;

const AUTO_ACCEPT_THRESHOLD: u32 = 3;

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
            if sounds_similar(raw_word, rw) || raw_word.to_lowercase() == rw.to_lowercase() {
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
        "Auto-learned correction".to_string(),
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
    if (al.len() as isize - bl.len() as isize).unsigned_abs() <= 1 {
        let max_len = al.len().max(bl.len());
        let diffs: usize = al.chars().zip(bl.chars()).filter(|(a, b)| a != b).count()
            + max_len.saturating_sub(al.len().min(bl.len()));
        return diffs <= 2;
    }
    false
}
