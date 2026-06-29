use super::window::{self, WindowContext};

const CONTEXT_SYNTHESIS_PROMPT: &str = "You are a context synthesis assistant for a speech-to-text dictation pipeline.\n\nGiven metadata about the user's active application and optionally a screenshot, produce exactly TWO sentences:\n1. What the user is currently doing (be specific: email recipient, Slack channel, document title, terminal command, code file, etc.)\n2. What their likely writing intent is (replying to a message, writing code, composing a document, entering a search query, etc.)\n\nPrioritize concrete details visible on screen: names, email addresses, channel names, file paths, code symbols, terminal commands.\n\nRules:\n- Output ONLY the two sentences, nothing else\n- Do not speculate beyond what is visible\n- If the screenshot is unclear, base your answer on the app/window metadata only\n- Keep it concise — this will be injected as context for transcription cleanup";

/// Synthesize a rich context description from window metadata and an optional
/// screenshot, using a vision-capable LLM. Mirrors synthesizeContext in
/// src/main/context/contextSynthesizer.ts.
pub async fn synthesize_context(
    ctx: &WindowContext,
    screenshot_path: Option<&str>,
    provider: &str,
    api_key: &str,
) -> Result<String, String> {
    // No screenshot and no meaningful metadata → nothing to synthesize.
    if screenshot_path.is_none() && ctx.app_name.is_empty() {
        return Ok(String::new());
    }
    // No API key → metadata-only fallback.
    if api_key.is_empty() {
        return Ok(metadata_only_context(ctx));
    }

    let metadata = {
        let mut lines = vec![format!(
            "Application: {}",
            if ctx.app_name.is_empty() { "Unknown" } else { ctx.app_name.as_str() }
        )];
        if !ctx.bundle_id.is_empty() {
            lines.push(format!("Bundle ID: {}", ctx.bundle_id));
        }
        if !ctx.window_title.is_empty() {
            lines.push(format!("Window Title: {}", ctx.window_title));
        }
        lines.join("\n")
    };

    // Compress the screenshot before sending it to the vision API.
    let optimized = screenshot_path.map(window::compress_screenshot);

    let result = match provider {
        "claude" => synthesize_with_claude(&metadata, optimized.as_deref(), api_key).await,
        "groq" => synthesize_with_groq(&metadata, optimized.as_deref(), api_key).await,
        _ => Ok(metadata_only_context(ctx)),
    };

    // Clean up the compressed temp file (the original PNG is cleaned by the caller).
    if let Some(opt) = &optimized {
        if Some(opt.as_str()) != screenshot_path {
            let _ = std::fs::remove_file(opt);
        }
    }

    match result {
        Ok(s) => Ok(s),
        Err(e) => {
            log::warn!("[context-synth] Vision synthesis failed, falling back to metadata: {}", e);
            Ok(metadata_only_context(ctx))
        }
    }
}

fn metadata_only_context(ctx: &WindowContext) -> String {
    if ctx.app_name.is_empty() {
        return String::new();
    }
    let mut s = format!("User is in {}", ctx.app_name);
    if !ctx.window_title.is_empty() {
        s.push_str(&format!(" with window \"{}\"", ctx.window_title));
    }
    s.push('.');
    s
}

fn user_text(metadata: &str) -> String {
    format!(
        "Window metadata:\n{}\n\nDescribe what the user is doing and their likely writing intent.",
        metadata
    )
}

async fn synthesize_with_claude(
    metadata: &str,
    screenshot_path: Option<&str>,
    api_key: &str,
) -> Result<String, String> {
    let mut content: Vec<serde_json::Value> = vec![];
    if let Some(path) = screenshot_path {
        if let Some(b64) = window::screenshot_to_base64(path) {
            content.push(serde_json::json!({
                "type": "image",
                "source": {
                    "type": "base64",
                    "media_type": window::screenshot_media_type(path),
                    "data": b64,
                },
            }));
        }
    }
    content.push(serde_json::json!({ "type": "text", "text": user_text(metadata) }));

    let client = reqwest::Client::new();
    let body = serde_json::json!({
        "model": "claude-haiku-4-5-20251001",
        "max_tokens": 200,
        "temperature": 0.2,
        "system": CONTEXT_SYNTHESIS_PROMPT,
        "messages": [{ "role": "user", "content": content }],
    });
    let resp = client
        .post("https://api.anthropic.com/v1/messages")
        .header("Content-Type", "application/json")
        .header("x-api-key", api_key)
        .header("anthropic-version", "2023-06-01")
        .timeout(std::time::Duration::from_secs(10))
        .json(&body)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        let status = resp.status();
        let err = resp.text().await.unwrap_or_default();
        return Err(format!("Claude vision API error {}: {}", status, err));
    }
    let data: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    let text = data["content"]
        .as_array()
        .map(|arr| {
            arr.iter()
                .filter(|c| c["type"] == "text")
                .filter_map(|c| c["text"].as_str())
                .collect::<Vec<_>>()
                .join("")
        })
        .unwrap_or_default()
        .trim()
        .to_string();
    log::info!("[context-synth] Claude vision result: \"{}\"", text);
    Ok(text)
}

async fn synthesize_with_groq(
    metadata: &str,
    screenshot_path: Option<&str>,
    api_key: &str,
) -> Result<String, String> {
    let mut content: Vec<serde_json::Value> = vec![];
    if let Some(path) = screenshot_path {
        if let Some(b64) = window::screenshot_to_base64(path) {
            let media = window::screenshot_media_type(path);
            content.push(serde_json::json!({
                "type": "image_url",
                "image_url": { "url": format!("data:{};base64,{}", media, b64) },
            }));
        }
    }
    content.push(serde_json::json!({ "type": "text", "text": user_text(metadata) }));

    let client = reqwest::Client::new();
    let body = serde_json::json!({
        "model": "llama-4-scout-17b-16e-instruct",
        "max_tokens": 200,
        "temperature": 0.2,
        "messages": [
            { "role": "system", "content": CONTEXT_SYNTHESIS_PROMPT },
            { "role": "user", "content": content },
        ],
    });
    let resp = client
        .post("https://api.groq.com/openai/v1/chat/completions")
        .header("Content-Type", "application/json")
        .header("Authorization", format!("Bearer {}", api_key))
        .timeout(std::time::Duration::from_secs(10))
        .json(&body)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        let status = resp.status();
        let err = resp.text().await.unwrap_or_default();
        return Err(format!("Groq vision API error {}: {}", status, err));
    }
    let data: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    let text = data["choices"][0]["message"]["content"]
        .as_str()
        .unwrap_or("")
        .trim()
        .to_string();
    log::info!("[context-synth] Groq vision result: \"{}\"", text);
    Ok(text)
}
