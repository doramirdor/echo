pub async fn refine(endpoint: &str, model: &str, raw: &str, system_prompt: &str) -> Result<String, String> {
    let endpoint = endpoint.trim_end_matches('/');
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
        .post(format!("{}/v1/chat/completions", endpoint))
        .header("Content-Type", "application/json")
        .timeout(std::time::Duration::from_secs(60))
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Llama local API error: {}", e))?;

    if !response.status().is_success() {
        let body = response.text().await.unwrap_or_default();
        return Err(format!("Llama local API error: {}", body));
    }

    let data: serde_json::Value = response.json().await.map_err(|e| format!("Parse: {}", e))?;
    let text = data["choices"][0]["message"]["content"].as_str().unwrap_or("").trim().to_string();
    log::info!("[llama-local] Refined: \"{}\"", text);
    Ok(text)
}
