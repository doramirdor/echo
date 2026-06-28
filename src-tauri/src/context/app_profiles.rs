use std::collections::HashMap;

pub fn get_profile_prompt(app_name: Option<&str>, overrides: &HashMap<String, String>) -> String {
    let name = match app_name {
        Some(n) if !n.is_empty() => n,
        _ => return String::new(),
    };

    if let Some(profile) = overrides.get(name) {
        return profile_prompt(profile);
    }

    let profile = match name {
        "Visual Studio Code" | "Code" | "Cursor" | "Xcode" | "iTerm2" | "Terminal" | "Warp" => "coding",
        "Notion" | "Google Chrome" | "Safari" | "Pages" | "Microsoft Word" => "prose",
        "Slack" | "Messages" | "Discord" | "Telegram" => "chat",
        _ => "default",
    };

    profile_prompt(profile)
}

fn profile_prompt(profile: &str) -> String {
    match profile {
        "coding" => "You are refining speech for a code editor. Preserve technical terms, variable names, and function names exactly. Use backticks for code identifiers when appropriate. Do not add prose formatting.".into(),
        "prose" => "You are refining speech for a document editor. Use proper grammar, punctuation, and paragraph structure. Capitalize sentences correctly.".into(),
        "chat" => "You are refining speech for a chat/messaging app. Keep the tone casual and conversational. Omit trailing periods on short messages unless clearly a full sentence.".into(),
        _ => String::new(),
    }
}
