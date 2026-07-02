use regex::Regex;

pub struct VoiceCommandResult {
    pub text: String,
    pub commands: Vec<String>,
    pub skip_refinement: bool,
}

struct Pattern {
    regex: Regex,
    action: &'static str,
    replacement: &'static str,
}

/// Deterministic code-dictation grammar. Converts spoken symbols to characters
/// and "<style> case <words>" phrases into identifiers (e.g. "snake case user id"
/// → "user_id"). Runs AFTER punctuation commands so a spoken "period"/"comma" or
/// a code symbol bounds the case-transform capture. Mirrors the TS `applyCodeGrammar`.
pub fn apply_code_grammar(text: &str) -> String {
    // Risky-in-prose words (equals, at, hash, pipe, caret, dollar) require a
    // disambiguating suffix; the unambiguous ones can be bare.
    let symbols: [(&str, &str); 22] = [
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

pub fn process_voice_commands(text: &str, enabled: bool, code_symbols: bool) -> VoiceCommandResult {
    if !enabled {
        return VoiceCommandResult { text: text.to_string(), commands: vec![], skip_refinement: false };
    }

    let patterns = [
        Pattern { regex: Regex::new(r"(?i)\bnew\s+line\b").unwrap(), action: "newline", replacement: "\n" },
        Pattern { regex: Regex::new(r"(?i)\bnew\s+paragraph\b").unwrap(), action: "newparagraph", replacement: "\n\n" },
        Pattern { regex: Regex::new(r"(?i)\bperiod\b").unwrap(), action: "period", replacement: "." },
        Pattern { regex: Regex::new(r"(?i)\bcomma\b").unwrap(), action: "comma", replacement: "," },
        Pattern { regex: Regex::new(r"(?i)\bquestion\s+mark\b").unwrap(), action: "questionmark", replacement: "?" },
        Pattern { regex: Regex::new(r"(?i)\bexclamation\s+(?:mark|point)\b").unwrap(), action: "exclamation", replacement: "!" },
        Pattern { regex: Regex::new(r"(?i)\bcolon\b").unwrap(), action: "colon", replacement: ":" },
        Pattern { regex: Regex::new(r"(?i)\bsemicolon\b").unwrap(), action: "semicolon", replacement: ";" },
        Pattern { regex: Regex::new(r"(?i)\bopen\s+(?:parenthesis|paren)\b").unwrap(), action: "openparen", replacement: "(" },
        Pattern { regex: Regex::new(r"(?i)\bclose\s+(?:parenthesis|paren)\b").unwrap(), action: "closeparen", replacement: ")" },
        Pattern { regex: Regex::new(r"(?i)\bscratch\s+that\b").unwrap(), action: "scratch", replacement: "" },
        Pattern { regex: Regex::new(r"(?i)\bundo\s+that\b").unwrap(), action: "undo", replacement: "" },
    ];

    let meta_commands = ["scratch", "undo"];
    let mut result = text.to_string();
    let mut commands = vec![];
    let mut skip_refinement = false;

    for p in &patterns {
        if p.regex.is_match(&result) {
            commands.push(p.action.to_string());
            if meta_commands.contains(&p.action) {
                skip_refinement = true;
            }
            result = p.regex.replace_all(&result, p.replacement).to_string();
        }
    }

    // Code grammar (symbols + case transforms) — only in code/shell contexts, and
    // after punctuation commands so their characters bound the case-transform capture.
    if code_symbols {
        let with_code = apply_code_grammar(&result);
        if with_code != result {
            commands.push("code-grammar".to_string());
            result = with_code;
        }
    }

    // Clean up whitespace
    let ws = Regex::new(r"[^\S\n]+").unwrap();
    let nl = Regex::new(r" *\n *").unwrap();
    result = ws.replace_all(&result, " ").to_string();
    result = nl.replace_all(&result, "\n").to_string();

    VoiceCommandResult { text: result.trim().to_string(), commands, skip_refinement }
}

#[cfg(test)]
mod tests {
    use super::*;

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
        let off = process_voice_commands("const snake case user id", true, false);
        assert!(off.text.contains("snake case user id"));
        assert!(!off.commands.iter().any(|c| c == "code-grammar"));

        let on = process_voice_commands("const snake case user id", true, true);
        assert!(on.text.contains("user_id"));
        assert!(on.commands.iter().any(|c| c == "code-grammar"));
    }
}
