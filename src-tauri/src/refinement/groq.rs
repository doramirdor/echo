// Refiner backed by Groq's OpenAI-compatible chat endpoint.
//
// Groq has no single audio->instructed-text endpoint, so transcription and
// refinement stay two calls; this is the second. We keep it to ONE LLM call by
// relying on the default refine prompt, which already fixes grammar,
// punctuation, and spelling -- there is no separate grammar pass to make.
//
// Default model is `llama-3.3-70b-versatile`: on Groq it's about as fast as the
// 8B for these short requests, but far more reliable at following the refine
// prompt (keeps deliberately-repeated content verbatim, doesn't swap "I"->"you").
// `llama-3.1-8b-instant` is cheaper but unstable on those, so it's opt-in.
pub async fn refine(api_key: &str, model: &str, raw: &str, system_prompt: &str) -> Result<String, String> {
    if api_key.is_empty() {
        return Err("Groq API key not configured".to_string());
    }

    let client = reqwest::Client::new();
    let user = super::refiner::build_refine_user_prompt(raw);
    let body = serde_json::json!({
        "model": model,
        "temperature": 0,
        "max_tokens": 1024,
        "messages": [
            { "role": "system", "content": system_prompt },
            { "role": "user", "content": user },
        ],
    });

    let response = client
        .post("https://api.groq.com/openai/v1/chat/completions")
        .header("Content-Type", "application/json")
        .header("Authorization", format!("Bearer {}", api_key))
        .timeout(std::time::Duration::from_secs(20))
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Groq API error: {}", e))?;

    if !response.status().is_success() {
        let body = response.text().await.unwrap_or_default();
        return Err(format!("Groq API error: {}", body));
    }

    let data: serde_json::Value = response.json().await.map_err(|e| format!("Parse: {}", e))?;
    let text = data["choices"][0]["message"]["content"]
        .as_str()
        .unwrap_or("")
        .trim()
        .to_string();

    log::info!("[groq-llm] Refined: \"{}\"", text);
    Ok(text)
}

#[cfg(test)]
mod tests {
    use super::*;

    // Mirrors groqRefiner.test.ts `throws when no API key is configured`.
    // The empty-key guard returns before any network call, so this exercises
    // the only pure seam here (the request build / response parse are inline in
    // the async HTTP path and have no fetch-mock equivalent in Rust — skipped).
    #[tokio::test]
    async fn refine_errors_when_api_key_missing() {
        let err = refine("", "llama-3.1-8b-instant", "hello world", "sys")
            .await
            .unwrap_err();
        assert!(err.contains("Groq API key"), "unexpected error: {}", err);
    }
}
