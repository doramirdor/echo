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

pub fn process_voice_commands(text: &str, enabled: bool) -> VoiceCommandResult {
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

    // Clean up whitespace
    let ws = Regex::new(r"[^\S\n]+").unwrap();
    let nl = Regex::new(r" *\n *").unwrap();
    result = ws.replace_all(&result, " ").to_string();
    result = nl.replace_all(&result, "\n").to_string();

    VoiceCommandResult { text: result.trim().to_string(), commands, skip_refinement }
}
