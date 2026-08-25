// Refiner backed by Google's Gemini API (generateContent). One call does
// refine + grammar — the default prompt already fixes grammar.
pub async fn refine(api_key: &str, model: &str, raw: &str, system_prompt: &str) -> Result<String, String> {
    if api_key.is_empty() {
        return Err("Gemini API key not configured".to_string());
    }

    let client = reqwest::Client::new();
    let url = format!(
        "https://generativelanguage.googleapis.com/v1beta/models/{}:generateContent",
        model
    );
    let user = super::refiner::build_refine_user_prompt(raw);
    let body = serde_json::json!({
        "systemInstruction": { "parts": [{ "text": system_prompt }] },
        "contents": [{ "role": "user", "parts": [{ "text": user }] }],
        "generationConfig": { "temperature": 0, "maxOutputTokens": 1024 },
    });

    let response = client
        .post(&url)
        .header("Content-Type", "application/json")
        .header("x-goog-api-key", api_key)
        .timeout(std::time::Duration::from_secs(30))
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Gemini API error: {}", e))?;

    if !response.status().is_success() {
        let body = response.text().await.unwrap_or_default();
        return Err(format!("Gemini API error: {}", body));
    }

    let data: serde_json::Value = response.json().await.map_err(|e| format!("Parse: {}", e))?;
    let text = data["candidates"][0]["content"]["parts"][0]["text"]
        .as_str()
        .unwrap_or("")
        .trim()
        .to_string();

    log::info!("[gemini] Refined: \"{}\"", text);
    Ok(text)
}

#[cfg(test)]
mod tests {
    use super::*;

    // Mirrors newRefiners.test.ts `GeminiRefiner > throws without an API key`.
    // The empty-key guard returns before any network call. The `calls
    // generateContent and parses candidate parts` test is a fetch round-trip
    // (URL/header/response-parse are inline in the async path) with no pure
    // Rust seam, so it's skipped.
    #[tokio::test]
    async fn refine_errors_when_api_key_missing() {
        let err = refine("", "gemini-2.0-flash", "hi there", "sys")
            .await
            .unwrap_err();
        assert!(err.contains("Gemini API key"), "unexpected error: {}", err);
    }
}
