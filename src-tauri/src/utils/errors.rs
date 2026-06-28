pub fn to_user_facing_error(err: &str) -> String {
    let lower = err.to_lowercase();

    if lower.contains("sox") || lower.contains("rec: command not found") || (lower.contains("enoent") && lower.contains("rec")) {
        return "SoX is not installed. Run: brew install sox".into();
    }
    if lower.contains("whisper") && (lower.contains("not found") || lower.contains("not ready")) {
        return "Whisper is not set up. Open Settings and build/download Whisper.".into();
    }
    if lower.contains("groq") && (lower.contains("api") || lower.contains("401") || lower.contains("403")) {
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
