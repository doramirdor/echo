pub async fn refine(api_key: &str, model: &str, raw: &str, system_prompt: &str) -> Result<String, String> {
    let client = reqwest::Client::new();
    let body = serde_json::json!({
        "model": model,
        "max_tokens": 1024,
        "messages": [
            { "role": "system", "content": system_prompt },
            { "role": "user", "content": raw },
        ],
    });

    let response = client
        .post("https://api.openai.com/v1/chat/completions")
        .header("Content-Type", "application/json")
        .header("Authorization", format!("Bearer {}", api_key))
        .timeout(std::time::Duration::from_secs(30))
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("OpenAI API error: {}", e))?;

    if !response.status().is_success() {
        let body = response.text().await.unwrap_or_default();
        return Err(format!("OpenAI API error: {}", body));
    }

    let data: serde_json::Value = response.json().await.map_err(|e| format!("Parse: {}", e))?;
    let text = data["choices"][0]["message"]["content"]
        .as_str()
        .unwrap_or("")
        .trim()
        .to_string();

    log::info!("[openai] Refined: \"{}\"", text);
    Ok(text)
}
