// Vocabulary learner - auto-learns corrections from raw vs refined diffs.
// Simplified port; the core logic matches the TypeScript version.

use super::store::MemoryStore;

pub fn analyze_and_learn(memory: &MemoryStore, raw: &str, refined: &str) {
    if raw.to_lowercase() == refined.to_lowercase() {
        return;
    }

    let raw_words: Vec<&str> = raw.split_whitespace().collect();
    let refined_words: Vec<&str> = refined.split_whitespace().collect();

    for rw in &refined_words {
        if rw.len() < 2 { continue; }
        for rword in &raw_words {
            if rword == rw { continue; }
            if sounds_similar(rword, rw) {
                log::info!("[vocab-learner] Potential correction: \"{}\" -> \"{}\"", rword, rw);
            }
        }
    }
}

fn sounds_similar(a: &str, b: &str) -> bool {
    let al = a.to_lowercase();
    let bl = b.to_lowercase();
    if al == bl { return true; }
    if (al.len() as isize - bl.len() as isize).unsigned_abs() <= 1 {
        let max_len = al.len().max(bl.len());
        let diffs: usize = al.chars().zip(bl.chars()).filter(|(a, b)| a != b).count()
            + max_len.saturating_sub(al.len().min(bl.len()));
        return diffs <= 2;
    }
    false
}
