use super::window::WindowContext;

pub async fn synthesize_context(
    ctx: &WindowContext,
    _screenshot_path: Option<&str>,
    provider: &str,
    api_key: &str,
) -> Result<String, String> {
    if ctx.app_name.is_empty() {
        return Ok(String::new());
    }
    if api_key.is_empty() {
        return Ok(metadata_only_context(ctx));
    }

    let metadata = format!(
        "Application: {}\nBundle ID: {}\nWindow Title: {}",
        ctx.app_name, ctx.bundle_id, ctx.window_title
    );

    let prompt = "You are a context synthesis assistant for a speech-to-text dictation pipeline.\n\nGiven metadata about the user's active application, produce exactly TWO sentences:\n1. What the user is currently doing\n2. What their likely writing intent is\n\nOutput ONLY the two sentences, nothing else.";

    let user_msg = format!("Window metadata:\n{}\n\nDescribe what the user is doing and their likely writing intent.", metadata);

    match provider {
        "claude" => {
            let client = reqwest::Client::new();
            let body = serde_json::json!({
                "model": "claude-haiku-4-5-20251001",
                "max_tokens": 200,
                "temperature": 0.2,
                "system": prompt,
                "messages": [{ "role": "user", "content": user_msg }],
            });
            let resp = client.post("https://api.anthropic.com/v1/messages")
                .header("Content-Type", "application/json")
                .header("x-api-key", api_key)
                .header("anthropic-version", "2023-06-01")
                .timeout(std::time::Duration::from_secs(10))
                .json(&body)
                .send().await
                .map_err(|e| e.to_string())?;
            let data: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
            Ok(data["content"][0]["text"].as_str().unwrap_or("").trim().to_string())
        }
        _ => Ok(metadata_only_context(ctx)),
    }
}

fn metadata_only_context(ctx: &WindowContext) -> String {
    if ctx.app_name.is_empty() { return String::new(); }
    let mut s = format!("User is in {}", ctx.app_name);
    if !ctx.window_title.is_empty() {
        s.push_str(&format!(" with window \"{}\"", ctx.window_title));
    }
    s.push('.');
    s
}
