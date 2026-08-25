pub fn to_user_facing_error(err: &str) -> String {
    let lower = err.to_lowercase();

    if lower.contains("audio recorder") || lower.contains("record.swift") || lower.contains("rec: command not found") {
        return "Audio recording is unavailable. Grant microphone access in System Settings → Privacy & Security → Microphone (and install Xcode Command Line Tools if prompted).".into();
    }
    if lower.contains("whisper") && (lower.contains("not found") || lower.contains("not ready")) {
        return "Whisper is not set up. Open Settings and build/download Whisper.".into();
    }
    // Only a true auth failure means the key is bad — other Groq API errors
    // (e.g. a 400 from empty/short audio) must not be mislabeled as a key problem.
    if lower.contains("groq") && (lower.contains("401") || lower.contains("403")) {
        return "Groq API key is invalid or missing. Check Settings.".into();
    }
    if lower.contains("accessibility") || lower.contains("not authorized") {
        return "Accessibility permission required. Open System Settings > Privacy & Security > Accessibility and enable Echo.".into();
    }
    if lower.contains("microphone") || lower.contains("audio") {
        return "Microphone access failed. Check System Settings > Privacy & Security > Microphone.".into();
    }
    if lower.contains("claude api") || lower.contains("anthropic") {
        return "Claude API error. Check your API key in Settings.".into();
    }
    if lower.contains("openai api") {
        return "OpenAI API error. Check your API key in Settings.".into();
    }
    if lower.contains("ollama") || (lower.contains("econnrefused") && lower.contains("11434")) {
        return "Ollama is not running. Start it with: ollama serve".into();
    }
    if lower.contains("deepgram") {
        return "Deepgram API error. Check your API key in Settings.".into();
    }
    if lower.contains("timeout") || lower.contains("timed out") {
        return "Operation timed out. Try again or check your network connection.".into();
    }
    if lower.contains("empty") || lower.contains("no speech") {
        return "No speech detected. Try speaking closer to the microphone.".into();
    }

    if err.len() > 200 { format!("{}...", &err[..200]) } else { err.to_string() }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Mirrors tests/errors.test.ts. The TS side wraps input in `new Error(...)`
    // and extracts `.message`; the Rust API takes the message string directly.
    #[test]
    fn maps_audio_recorder_errors() {
        assert!(to_user_facing_error("rec: command not found").contains("Audio recording"));
    }

    #[test]
    fn maps_whisper_errors() {
        assert!(to_user_facing_error("Whisper binary not found").contains("Whisper"));
    }

    #[test]
    fn maps_accessibility_errors() {
        assert!(to_user_facing_error("Not authorized assistive").contains("Accessibility"));
    }

    #[test]
    fn passes_through_short_unknown_errors() {
        assert_eq!(to_user_facing_error("Something went wrong"), "Something went wrong");
    }
}
