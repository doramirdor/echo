//! Builds an "initial prompt" for the STT engine that biases recognition toward
//! the user's jargon, project terminology, and frequently-corrected words.
//!
//! whisper.cpp (and the OpenAI/Groq Whisper APIs) accept a short prior-context
//! string that nudges the decoder toward specific spellings. Feeding the project
//! vocabulary here fixes terms *during* recognition — far more reliable than
//! correcting them afterwards with the LLM, and it costs nothing.
//!
//! Mirrors `src/main/transcription/speechBias.ts`.

use std::collections::HashSet;

use regex::Regex;

use crate::memory::store::MemoryEntry;

// whisper attends to ~224 tokens of prompt; ~900 chars is a safe ceiling.
const MAX_PROMPT_CHARS: usize = 900;

/// Heuristically extract code-/domain-identifiers from a free-form context doc:
/// CamelCase, snake_case, dotted.names, ALL_CAPS acronyms, and backtick/quoted tokens.
pub fn extract_identifiers(text: &str) -> Vec<String> {
    if text.is_empty() {
        return vec![];
    }
    let mut found: Vec<String> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    let mut push = |t: &str| {
        if !t.is_empty() && seen.insert(t.to_string()) {
            found.push(t.to_string());
        }
    };

    // Tokens inside backticks or quotes are almost always names worth keeping.
    let quoted = Regex::new(r#"[`"']([A-Za-z][A-Za-z0-9_.-]{1,40})[`"']"#).unwrap();
    for cap in quoted.captures_iter(text) {
        if let Some(m) = cap.get(1) {
            push(m.as_str());
        }
    }

    // Bare identifier-ish tokens: must look "technical" rather than plain English.
    let bare = Regex::new(r"[A-Za-z][A-Za-z0-9_.]{2,40}").unwrap();
    let camel = Regex::new(r"[a-z][A-Z]").unwrap();
    let dotted = Regex::new(r"(?i)[a-z]\.[a-z]").unwrap();
    let acronym = Regex::new(r"^[A-Z]{2,6}$").unwrap();
    for m in bare.find_iter(text) {
        let tok = m.as_str();
        let is_camel = camel.is_match(tok);
        let has_underscore = tok.contains('_');
        let is_dotted = dotted.is_match(tok);
        let is_acronym = acronym.is_match(tok);
        if is_camel || has_underscore || is_dotted || is_acronym {
            push(tok);
        }
    }

    found
}

/// Split a free-text vocabulary list (newlines/commas) into trimmed terms.
fn split_terms(list: &str) -> Vec<String> {
    list.split(['\n', ','])
        .map(|t| t.trim().to_string())
        .filter(|t| !t.is_empty())
        .collect()
}

pub fn build_speech_bias_prompt(
    vocabulary_list: &str,
    memory_entries: &[MemoryEntry],
    project_context: Option<&str>,
) -> String {
    let mut terms: Vec<String> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    let mut push = |t: &str| {
        let key = t.to_lowercase();
        if !t.is_empty() && seen.insert(key) {
            terms.push(t.to_string());
        }
    };

    // 1. User vocabulary list — highest priority (explicitly curated).
    for t in split_terms(vocabulary_list) {
        push(&t);
    }

    // 2. Learned memory terms — things the user has corrected before.
    for e in memory_entries {
        push(&e.term);
    }

    // 3. Project jargon mined from the scanned codebase context.
    if let Some(pc) = project_context {
        for id in extract_identifiers(pc) {
            push(&id);
        }
    }

    if terms.is_empty() {
        return String::new();
    }

    // Phrase it as natural prior context so the decoder treats it as vocabulary,
    // not as something to transcribe. Cap to the token window.
    let mut prompt = format!("Vocabulary: {}.", terms.join(", "));
    if prompt.len() > MAX_PROMPT_CHARS {
        // Truncate on a char boundary, then back up to the last clean separator.
        let mut end = MAX_PROMPT_CHARS;
        while !prompt.is_char_boundary(end) {
            end -= 1;
        }
        prompt.truncate(end);
        if let Some(last_comma) = prompt.rfind(',') {
            if last_comma > 40 {
                prompt.truncate(last_comma);
                prompt.push('.');
            }
        }
    }
    prompt
}
