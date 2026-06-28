// Refiner backed by Groq's OpenAI-compatible chat endpoint.
//
// Groq has no single audio->instructed-text endpoint, so transcription and
// refinement stay two calls; this is the second. We keep it to ONE LLM call by
// relying on the default refine prompt, which already fixes grammar,
// punctuation, and spelling -- there is no separate grammar pass to make.
//
// `llama-3.1-8b-instant` has the lowest time-to-first-token on Groq, which is
// what dominates time-to-first-insertion for short dictations.
pub async fn refine(api_key: &str, model: &str, raw: &str, system_prompt: &str) -> Result<String, String> {
    if api_key.is_empty() {
        return Err("Groq API key not configured".to_string());
    }

    let client = reqwest::Client::new();
    let body = serde_json::json!({
        "model": model,
        "temperature": 0,
        "max_tokens": 1024,
        "messages": [
            { "role": "system", "content": system_prompt },
            { "role": "user", "content": raw },
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
