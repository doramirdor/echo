//! Sentence-continuation helpers.
//!
//! When the cursor is placed in the middle of (or at the end of) existing text,
//! dictated speech should *continue* that text rather than start fresh. The LLM
//! is told about the surrounding text, but the mechanical join — spacing and
//! leading capitalisation — is done here deterministically so it's fast, free,
//! and predictable regardless of which (or whether an) LLM ran.
//!
//! Mirrors `src/main/insertion/continuation.ts`.

const SENTENCE_ENDERS: &[char] = &['.', '!', '?', ':', ';'];
const OPENERS: &[char] = &['(', '[', '{', '"', '\'', '\u{201c}', '\u{2018}', '<'];

/// Is the caret sitting mid-sentence? True when there is preceding text whose
/// last non-space character is not sentence-ending punctuation. In that case the
/// dictated text is a continuation and should not be re-capitalised.
fn is_mid_sentence(before: &str) -> bool {
    let trimmed = before.trim_end();
    match trimmed.chars().last() {
        Some(last) => !SENTENCE_ENDERS.contains(&last),
        None => false,
    }
}

/// Should a space be inserted between `before` and the new text?
fn needs_leading_space(before: &str, next: &str) -> bool {
    let last_char = match before.chars().last() {
        Some(c) => c,
        None => return false,
    };
    if last_char.is_whitespace() {
        return false;
    }
    if OPENERS.contains(&last_char) {
        return false;
    }
    let first_char = match next.chars().next() {
        Some(c) => c,
        None => return false,
    };
    // Don't space before closing/clinging punctuation.
    const CLINGING: &[char] = &[
        '.', ',', '!', '?', ';', ':', ')', ']', '}', '\'', '"', '\u{201d}', '\u{2019}',
    ];
    if CLINGING.contains(&first_char) {
        return false;
    }
    true
}

/// A word that should keep its original casing even mid-sentence:
/// "I"/"I'm", acronyms (API), code identifiers (camelCase, snake_case, dotted).
fn preserves_case(word: &str) -> bool {
    if word == "I" || word.starts_with("I'") || word.starts_with("I\u{2019}") {
        return true;
    }
    // ALL-CAPS acronym (2+ uppercase letters).
    if word.len() >= 2 && word.chars().all(|c| c.is_ascii_uppercase()) {
        return true;
    }
    // camelCase / PascalCase: a lowercase letter immediately followed by uppercase.
    let chars: Vec<char> = word.chars().collect();
    for i in 0..chars.len().saturating_sub(1) {
        if chars[i].is_ascii_lowercase() && chars[i + 1].is_ascii_uppercase() {
            return true;
        }
    }
    // snake_case or dotted identifier (letter.letter).
    if word.contains('_') {
        return true;
    }
    for i in 1..chars.len().saturating_sub(1) {
        if chars[i] == '.' && chars[i - 1].is_ascii_alphabetic() && chars[i + 1].is_ascii_alphabetic()
        {
            return true;
        }
    }
    false
}

/// Lowercase only the first letter of the first word, when safe to do so.
fn decapitalize_first(text: &str) -> String {
    // Split into leading whitespace, first word, and the rest.
    let lead_len = text.find(|c: char| !c.is_whitespace()).unwrap_or(text.len());
    let (lead, rest) = text.split_at(lead_len);
    if rest.is_empty() {
        return text.to_string();
    }
    let word_len = rest.find(|c: char| c.is_whitespace()).unwrap_or(rest.len());
    let (word, tail) = rest.split_at(word_len);
    if preserves_case(word) {
        return text.to_string();
    }
    let mut word_chars = word.chars();
    let first = match word_chars.next() {
        Some(c) => c,
        None => return text.to_string(),
    };
    let lowered: String = first.to_lowercase().chain(word_chars).collect();
    format!("{}{}{}", lead, lowered, tail)
}

/// Produce the exact string to insert at the caret so it flows from `before`.
/// Returns ONLY the new text (adjusted), never the existing text.
///
/// - Adds a leading space when joining two words.
/// - Lowercases the first letter when continuing mid-sentence (unless the word
///   preserves case, e.g. "I", acronyms, identifiers).
pub fn join_continuation(before: &str, new_text: &str) -> String {
    if new_text.is_empty() || before.is_empty() {
        return new_text.to_string();
    }

    let mut result = new_text.to_string();
    if is_mid_sentence(before) {
        result = decapitalize_first(&result);
    }
    if needs_leading_space(before, &result) {
        result = format!(" {}", result);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn appends_space_between_words() {
        assert_eq!(join_continuation("hello", "world"), " world");
    }

    #[test]
    fn decapitalizes_mid_sentence() {
        assert_eq!(join_continuation("I was thinking", "Then we go"), " then we go");
    }

    #[test]
    fn keeps_capital_after_sentence_end() {
        assert_eq!(join_continuation("Done.", "Then we go"), " Then we go");
    }

    #[test]
    fn preserves_acronyms_and_i() {
        assert_eq!(join_continuation("we use", "API calls"), " API calls");
        assert_eq!(join_continuation("and then", "I went"), " I went");
        assert_eq!(join_continuation("call", "getUser now"), " getUser now");
    }

    #[test]
    fn no_space_after_opener_or_before_punctuation() {
        assert_eq!(join_continuation("(", "note"), "note");
        assert_eq!(join_continuation("word", ", more"), ", more");
    }

    #[test]
    fn no_double_space() {
        assert_eq!(join_continuation("hello ", "world"), "world");
    }
}
