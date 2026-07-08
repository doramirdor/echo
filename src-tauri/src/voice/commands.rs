use regex::Regex;
use std::collections::HashSet;

pub struct VoiceCommandResult {
    pub text: String,
    pub commands: Vec<String>,
    pub skip_refinement: bool,
}

/// Options for `process_voice_commands`. Mirrors the TS `VoiceCommandOptions`.
#[derive(Default, Clone, Copy)]
pub struct VoiceCommandOptions {
    /// Enable the deterministic code-dictation grammar (spoken symbols and case
    /// transforms). Only meaningful in code/shell contexts — the caller gates
    /// this on the app profile so prose/email/chat are never affected.
    pub code_symbols: bool,
    /// True when an LLM refiner will run on this transcript. Scratch/undo phrases
    /// are then left in the text untouched — the refiner's base prompt already
    /// implements self-correction and removes the discarded content. When false
    /// (default), scratch/undo is applied deterministically here.
    pub refiner_available: bool,
}

struct Pattern {
    regex: Regex,
    action: &'static str,
    replacement: &'static str,
    guarded: bool,
}

/// Deterministic code-dictation grammar. Converts spoken symbols to characters
/// and "<style> case <words>" phrases into identifiers (e.g. "snake case user id"
/// → "user_id"). Runs AFTER punctuation commands so a spoken "period"/"comma" or
/// a code symbol bounds the case-transform capture. Mirrors the TS `applyCodeGrammar`.
pub fn apply_code_grammar(text: &str) -> String {
    // Risky-in-prose words (equals, at, hash, pipe, caret, dollar) require a
    // disambiguating suffix; the unambiguous ones can be bare.
    let symbols: [(&str, &str); 23] = [
        (r"(?i)\bopen\s+brace\b", "{"),
        (r"(?i)\bclose\s+brace\b", "}"),
        (r"(?i)\bopen\s+bracket\b", "["),
        (r"(?i)\bclose\s+bracket\b", "]"),
        (r"(?i)\bopen\s+angle\s+bracket\b", "<"),
        (r"(?i)\bclose\s+angle\s+bracket\b", ">"),
        (r"(?i)\bfat\s+arrow\b", "=>"),
        (r"(?i)\bthin\s+arrow\b", "->"),
        (r"(?i)\btriple\s+equals\b", "==="),
        (r"(?i)\bdouble\s+equals\b", "=="),
        (r"(?i)\bnot\s+equals?\b", "!="),
        (r"(?i)\bequals\s+sign\b", "="),
        (r"(?i)\bbacktick\b", "`"),
        (r"(?i)\bpipe\s+(?:symbol|character)\b", "|"),
        (r"(?i)\bdollar\s+sign\b", "$"),
        (r"(?i)\b(?:hash\s+(?:sign|tag)|pound\s+sign)\b", "#"),
        (r"(?i)\bat\s+sign\b", "@"),
        (r"(?i)\bunderscore\b", "_"),
        (r"(?i)\basterisk\b", "*"),
        (r"(?i)\bampersand\b", "&"),
        (r"(?i)\bcaret\s+(?:symbol|character)\b", "^"),
        (r"(?i)\bforward\s+slash\b", "/"),
        (r"(?i)\bback\s?slash\b", "\\"),
    ];

    let mut out = text.to_string();
    for (re, rep) in symbols.iter() {
        let regex = Regex::new(re).unwrap();
        // Replacement strings may contain regex-special chars like `$`; escape `$`.
        let safe = rep.replace('$', "$$");
        out = regex.replace_all(&out, safe.as_str()).to_string();
    }

    let case_re = Regex::new(r"(?i)\b(camel|pascal|snake|kebab|constant|screaming\s+snake)\s+case\s+([a-z0-9]+(?:\s+[a-z0-9]+){0,5})").unwrap();
    out = case_re
        .replace_all(&out, |caps: &regex::Captures| {
            let style = caps[1].to_lowercase();
            let style = style.split_whitespace().collect::<Vec<_>>().join(" ");
            let words: Vec<String> = caps[2].split_whitespace().map(|w| w.to_lowercase()).collect();
            join_case(&style, &words)
        })
        .to_string();

    out
}

fn join_case(style: &str, words: &[String]) -> String {
    let cap = |w: &String| -> String {
        let mut c = w.chars();
        match c.next() {
            Some(f) => f.to_uppercase().collect::<String>() + c.as_str(),
            None => String::new(),
        }
    };
    match style {
        "camel" => words
            .iter()
            .enumerate()
            .map(|(i, w)| if i == 0 { w.clone() } else { cap(w) })
            .collect(),
        "pascal" => words.iter().map(cap).collect(),
        "snake" => words.join("_"),
        "kebab" => words.join("-"),
        "constant" | "screaming snake" => {
            words.iter().map(|w| w.to_uppercase()).collect::<Vec<_>>().join("_")
        }
        _ => words.join(" "),
    }
}

/// Determiners/possessives and adjective-ish modifiers that precede the NOUN
/// sense of period/comma/colon/semicolon. Mirrors the TS `NOUN_CONTEXT_BEFORE`.
fn noun_context_before() -> &'static HashSet<&'static str> {
    use std::sync::OnceLock;
    static SET: OnceLock<HashSet<&'static str>> = OnceLock::new();
    SET.get_or_init(|| {
        [
            "the", "a", "an", "this", "that", "these", "those", "each", "every", "any",
            "some", "another", "my", "your", "our", "his", "her", "its", "their", "whose",
            "one", "same", "whole", "entire", "long", "short", "brief", "extended",
            "trial", "grace", "time", "holding", "question", "waiting", "incubation",
            "probation", "probationary", "notice", "cooling-off", "refractory",
            "gestation", "quiet", "rest", "transition", "oxford", "serial", "inverted",
        ]
        .into_iter()
        .collect()
    })
}

/// Prepositions/complementizers (plus a few noun-compound tails) that follow the
/// noun sense ("period of time", "colon cancer"). Mirrors `NOUN_CONTEXT_AFTER`.
fn noun_context_after() -> &'static HashSet<&'static str> {
    use std::sync::OnceLock;
    static SET: OnceLock<HashSet<&'static str>> = OnceLock::new();
    SET.get_or_init(|| {
        [
            "of", "in", "on", "at", "by", "for", "from", "to", "into", "within",
            "during", "when", "where", "that", "which", "between", "after", "before",
            "over", "under", "until", "since", "while", "cancer", "separated", "delimited",
        ]
        .into_iter()
        .collect()
    })
}

/// True when the punctuation word at `[offset, offset+length)` in `full` is being
/// used as an ordinary English noun rather than a spoken command. Mirrors the TS
/// `isPunctuationNounContext`. `offset`/`length` are byte offsets (regex-derived).
fn is_punctuation_noun_context(full: &str, offset: usize, length: usize) -> bool {
    let bytes = full.as_bytes();
    // Hyphenated compound: "comma-separated", "semicolon-delimited".
    if offset > 0 && bytes[offset - 1] == b'-' {
        return true;
    }
    if offset + length < bytes.len() && bytes[offset + length] == b'-' {
        return true;
    }

    // Adjacent words only (whitespace between) — a sentence boundary in between
    // means the neighbor belongs to another clause and is not noun context.
    let before = &full[..offset];
    if let Some(caps) = Regex::new(r"(?i)([a-z'-]+)\s*$").unwrap().captures(before) {
        if noun_context_before().contains(caps[1].to_lowercase().as_str()) {
            return true;
        }
    }
    let after = &full[offset + length..];
    if let Some(caps) = Regex::new(r"(?i)^\s*([a-z'-]+)").unwrap().captures(after) {
        if noun_context_after().contains(caps[1].to_lowercase().as_str()) {
            return true;
        }
    }
    false
}

/// Index (byte offset) just past the last sentence terminator in `s` (0 if none).
fn sentence_start(s: &str) -> usize {
    // Iterate over char boundaries; terminators here are all single-byte ASCII.
    let bytes = s.as_bytes();
    let mut i = bytes.len();
    while i > 0 {
        i -= 1;
        let ch = bytes[i];
        if ch == b'.' || ch == b'!' || ch == b'?' || ch == b'\n' {
            return i + 1;
        }
    }
    0
}

/// Deterministic scratch/undo semantics for when no refiner will run: embedded
/// mid-sentence ("hello scratch that") deletes from the start of that sentence
/// through the phrase; standing alone as its own sentence ("Hello. Scratch that.")
/// also deletes the previous sentence. Mirrors the TS `applyScratchCommands`.
fn apply_scratch_commands(text: &str) -> (String, Vec<String>) {
    let phrase = Regex::new(r"(?i)\b(scratch|undo)\s+that\b\s*[.!?,]*").unwrap();
    let mut actions: Vec<String> = Vec::new();
    let mut out = text.to_string();

    while let Some(m) = phrase.captures(&out) {
        let whole = m.get(0).unwrap();
        let word = m.get(1).unwrap().as_str().to_lowercase();
        let action = if word == "undo" { "undo" } else { "scratch" };
        if !actions.iter().any(|a| a == action) {
            actions.push(action.to_string());
        }

        let m_index = whole.start();
        let m_end = whole.end();

        let before = &out[..m_index];
        let mut from = sentence_start(before);
        if before[from..].trim().is_empty() {
            // The phrase is its own sentence — discard the previous sentence too.
            let cut = from.saturating_sub(1);
            from = sentence_start(&before[..cut]);
        }

        let left = out[..from].to_string();
        let right = out[m_end..].to_string();

        let need_space = !left.is_empty()
            && !right.is_empty()
            && !left.ends_with(char::is_whitespace)
            && !right.starts_with(char::is_whitespace);
        out = if need_space {
            format!("{} {}", left, right)
        } else {
            format!("{}{}", left, right)
        };
    }

    (out, actions)
}

/// Process voice commands embedded in transcription text. Mirrors the TS
/// `processVoiceCommands`.
pub fn process_voice_commands(
    text: &str,
    enabled: bool,
    opts: VoiceCommandOptions,
) -> VoiceCommandResult {
    if !enabled {
        return VoiceCommandResult { text: text.to_string(), commands: vec![], skip_refinement: false };
    }

    // The bare punctuation words double as ordinary English nouns; `guarded`
    // entries skip replacement in noun contexts. Two-word explicit forms are
    // unambiguous and always fire.
    let patterns = [
        Pattern { regex: Regex::new(r"(?i)\bnew\s+line\b").unwrap(), action: "newline", replacement: "\n", guarded: false },
        Pattern { regex: Regex::new(r"(?i)\bnew\s+paragraph\b").unwrap(), action: "newparagraph", replacement: "\n\n", guarded: false },
        Pattern { regex: Regex::new(r"(?i)\bperiod\b").unwrap(), action: "period", replacement: ".", guarded: true },
        Pattern { regex: Regex::new(r"(?i)\bcomma\b").unwrap(), action: "comma", replacement: ",", guarded: true },
        Pattern { regex: Regex::new(r"(?i)\bquestion\s+mark\b").unwrap(), action: "questionmark", replacement: "?", guarded: false },
        Pattern { regex: Regex::new(r"(?i)\bexclamation\s+(?:mark|point)\b").unwrap(), action: "exclamation", replacement: "!", guarded: false },
        Pattern { regex: Regex::new(r"(?i)\bcolon\b").unwrap(), action: "colon", replacement: ":", guarded: true },
        Pattern { regex: Regex::new(r"(?i)\bsemicolon\b").unwrap(), action: "semicolon", replacement: ";", guarded: true },
        Pattern { regex: Regex::new(r"(?i)\bopen\s+(?:parenthesis|paren)\b").unwrap(), action: "openparen", replacement: "(", guarded: false },
        Pattern { regex: Regex::new(r"(?i)\bclose\s+(?:parenthesis|paren)\b").unwrap(), action: "closeparen", replacement: ")", guarded: false },
    ];

    let mut result = text.to_string();
    let mut commands: Vec<String> = vec![];
    let mut skip_refinement = false;

    for p in &patterns {
        let mut matched = false;
        // Replace matches, skipping guarded matches that fall in a noun context.
        // A closure needs the full haystack for context lookups, so capture a
        // snapshot of the current `result` for each pattern pass.
        let snapshot = result.clone();
        let replacement = p.replacement;
        let guarded = p.guarded;
        let new_result = p
            .regex
            .replace_all(&snapshot, |caps: &regex::Captures| {
                let m = caps.get(0).unwrap();
                if guarded && is_punctuation_noun_context(&snapshot, m.start(), m.end() - m.start()) {
                    return m.as_str().to_string();
                }
                matched = true;
                replacement.to_string()
            })
            .to_string();
        result = new_result;
        if matched {
            commands.push(p.action.to_string());
        }
    }

    // Scratch/undo: with a refiner available the phrase is left untouched — the
    // refiner's self-correction prompt removes the discarded content. Without
    // one, apply deterministic sentence-level deletion here.
    if !opts.refiner_available {
        let (scratched_text, scratched_actions) = apply_scratch_commands(&result);
        if !scratched_actions.is_empty() {
            result = scratched_text;
            commands.extend(scratched_actions);
            skip_refinement = true;
        }
    }

    // Code grammar (symbols + case transforms) — only in code/shell contexts, and
    // after punctuation commands so their characters bound the case-transform capture.
    if opts.code_symbols {
        let with_code = apply_code_grammar(&result);
        if with_code != result {
            commands.push("code-grammar".to_string());
            result = with_code;
        }
    }

    // Clean up whitespace: collapse runs of non-newline whitespace to a single
    // space, trim spaces around newlines, then trim the ends.
    let ws = Regex::new(r"[^\S\n]+").unwrap();
    let nl = Regex::new(r" *\n *").unwrap();
    result = ws.replace_all(&result, " ").to_string();
    result = nl.replace_all(&result, "\n").to_string();

    VoiceCommandResult { text: result.trim().to_string(), commands, skip_refinement }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(text: &str, enabled: bool) -> VoiceCommandResult {
        process_voice_commands(text, enabled, VoiceCommandOptions::default())
    }

    fn run_opts(text: &str, opts: VoiceCommandOptions) -> VoiceCommandResult {
        process_voice_commands(text, true, opts)
    }

    #[test]
    fn returns_text_unchanged_when_disabled() {
        let r = run("hello new line world", false);
        assert_eq!(r.text, "hello new line world");
        assert!(r.commands.is_empty());
    }

    #[test]
    fn converts_new_line_and_paragraph() {
        let r = run("hello new line world", true);
        assert_eq!(r.text, "hello\nworld");
        assert!(r.commands.iter().any(|c| c == "newline"));

        let p = run("first new paragraph second", true);
        assert!(p.text.contains("\n\n"));
        assert!(p.commands.iter().any(|c| c == "newparagraph"));
    }

    #[test]
    fn converts_period_command() {
        let r = run("hello period", true);
        assert_eq!(r.text, "hello .");
        assert!(r.commands.iter().any(|c| c == "period"));
    }

    #[test]
    fn converts_mid_utterance_punctuation() {
        let r = run("first thought period second thought", true);
        assert_eq!(r.text, "first thought . second thought");
        assert!(r.commands.iter().any(|c| c == "period"));
    }

    #[test]
    fn converts_repeated_commas() {
        let r = run("add milk comma eggs comma bread", true);
        assert_eq!(r.text, "add milk , eggs , bread");
        assert!(r.commands.iter().any(|c| c == "comma"));
    }

    #[test]
    fn noun_context_guard() {
        let r = run("the trial period ended", true);
        assert_eq!(r.text, "the trial period ended");
        assert!(!r.commands.iter().any(|c| c == "period"));

        let g = run("the grace period expires tomorrow", true);
        assert_eq!(g.text, "the grace period expires tomorrow");
        assert!(!g.commands.iter().any(|c| c == "period"));

        let h = run("export it as comma-separated values", true);
        assert_eq!(h.text, "export it as comma-separated values");
        assert!(!h.commands.iter().any(|c| c == "comma"));

        let c = run("there is a colon in the URL", true);
        assert_eq!(c.text, "there is a colon in the URL");
        assert!(!c.commands.iter().any(|c| c == "colon"));

        let s = run("put a semicolon between clauses", true);
        assert_eq!(s.text, "put a semicolon between clauses");
        assert!(!s.commands.iter().any(|c| c == "semicolon"));

        let ok = run("see you tomorrow period", true);
        assert_eq!(ok.text, "see you tomorrow .");
        assert!(ok.commands.iter().any(|c| c == "period"));
    }

    #[test]
    fn scratch_deletes_whole_sentence_embedded() {
        let r = run("hello scratch that", true);
        assert_eq!(r.text, "");
        assert!(r.commands.iter().any(|c| c == "scratch"));
        assert!(r.skip_refinement);
    }

    #[test]
    fn scratch_keeps_content_after() {
        let r = run("send the report scratch that email the team", true);
        assert_eq!(r.text, "email the team");
        assert!(r.commands.iter().any(|c| c == "scratch"));
    }

    #[test]
    fn scratch_only_back_to_previous_boundary() {
        let r = run("Keep this. now delete scratch that and keep going", true);
        assert_eq!(r.text, "Keep this. and keep going");
    }

    #[test]
    fn scratch_standalone_deletes_previous_sentence() {
        let r = run("Hello there. Scratch that. How are you?", true);
        assert_eq!(r.text, "How are you?");
        assert!(r.commands.iter().any(|c| c == "scratch"));
    }

    #[test]
    fn undo_standalone_at_end() {
        let r = run("The meeting is at three. Undo that.", true);
        assert_eq!(r.text, "");
        assert!(r.commands.iter().any(|c| c == "undo"));
        assert!(r.skip_refinement);
    }

    #[test]
    fn newline_is_a_sentence_boundary() {
        let r = run("first line\nsecond line scratch that", true);
        assert_eq!(r.text, "first line");
    }

    #[test]
    fn scratch_passes_through_with_refiner() {
        let opts = VoiceCommandOptions { code_symbols: false, refiner_available: true };
        let r = run_opts("hello world scratch that", opts);
        assert_eq!(r.text, "hello world scratch that");
        assert!(!r.commands.iter().any(|c| c == "scratch"));
        assert!(!r.skip_refinement);

        let u = run_opts("The price is fifty. Undo that.", opts);
        assert_eq!(u.text, "The price is fifty. Undo that.");
        assert!(!u.commands.iter().any(|c| c == "undo"));
        assert!(!u.skip_refinement);
    }

    #[test]
    fn punctuation_still_fires_with_refiner() {
        let opts = VoiceCommandOptions { code_symbols: false, refiner_available: true };
        let r = run_opts("hello period", opts);
        assert_eq!(r.text, "hello .");
        assert!(r.commands.iter().any(|c| c == "period"));
    }

    #[test]
    fn converts_brackets_arrows_and_operators() {
        assert_eq!(apply_code_grammar("open brace close brace"), "{ }");
        assert_eq!(apply_code_grammar("fat arrow"), "=>");
        assert_eq!(apply_code_grammar("thin arrow"), "->");
        assert_eq!(apply_code_grammar("triple equals"), "===");
        assert_eq!(apply_code_grammar("not equal"), "!=");
    }

    #[test]
    fn prose_risky_symbols_need_a_suffix() {
        assert_eq!(apply_code_grammar("meet me at the hash of things"), "meet me at the hash of things");
        assert_eq!(apply_code_grammar("hash sign"), "#");
        assert_eq!(apply_code_grammar("dollar sign"), "$");
        assert_eq!(apply_code_grammar("pipe symbol"), "|");
    }

    #[test]
    fn applies_each_case_style() {
        assert_eq!(apply_code_grammar("camel case user profile id"), "userProfileId");
        assert_eq!(apply_code_grammar("pascal case user profile"), "UserProfile");
        assert_eq!(apply_code_grammar("snake case max retry count"), "max_retry_count");
        assert_eq!(apply_code_grammar("kebab case my component"), "my-component");
        assert_eq!(apply_code_grammar("constant case max size"), "MAX_SIZE");
        assert_eq!(apply_code_grammar("screaming snake case api key"), "API_KEY");
    }

    #[test]
    fn case_transform_is_bounded_by_a_converted_symbol() {
        assert_eq!(apply_code_grammar("snake case user id open brace"), "user_id {");
    }

    #[test]
    fn code_grammar_gated_on_flag() {
        let off = process_voice_commands(
            "const snake case user id",
            true,
            VoiceCommandOptions { code_symbols: false, refiner_available: false },
        );
        assert!(off.text.contains("snake case user id"));
        assert!(!off.commands.iter().any(|c| c == "code-grammar"));

        let on = process_voice_commands(
            "const snake case user id",
            true,
            VoiceCommandOptions { code_symbols: true, refiner_available: false },
        );
        assert!(on.text.contains("user_id"));
        assert!(on.commands.iter().any(|c| c == "code-grammar"));
    }
}
