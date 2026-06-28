// Refiner backed by AWS Bedrock (InvokeModel), using static IAM credentials
// signed with SigV4 (no AWS SDK dependency — see utils/sigv4.rs).
//
// Assumes an Anthropic Claude model on Bedrock, so request/response bodies use
// the Anthropic Messages format. One call does refine + grammar.
use crate::utils::sigv4::{sign_request, SigV4Request};

pub async fn refine(
    access_key_id: &str,
    secret_access_key: &str,
    region: &str,
    model: &str,
    raw: &str,
    system_prompt: &str,
) -> Result<String, String> {
    if access_key_id.is_empty() || secret_access_key.is_empty() {
        return Err("AWS credentials for Bedrock not configured".to_string());
    }
    let region = if region.is_empty() { "us-east-1" } else { region };
    let host = format!("bedrock-runtime.{}.amazonaws.com", region);
    let path = format!("/model/{}/invoke", model);
    let body = serde_json::json!({
        "anthropic_version": "bedrock-2023-05-31",
        "max_tokens": 1024,
        "temperature": 0,
        "system": system_prompt,
        "messages": [{ "role": "user", "content": raw }],
    })
    .to_string();

    let signed = sign_request(&SigV4Request {
        method: "POST",
        host: &host,
        path: &path,
        region,
        service: "bedrock",
        body: &body,
        access_key_id,
        secret_access_key,
        content_type: Some("application/json"),
        amz_date: None,
    });

    let client = reqwest::Client::new();
    let mut request = client
        .post(format!("https://{}{}", host, path))
        .header("Accept", "application/json")
        .timeout(std::time::Duration::from_secs(30))
        .body(body);
    for (k, v) in &signed {
        request = request.header(k.as_str(), v.as_str());
    }

    let response = request
        .send()
        .await
        .map_err(|e| format!("Bedrock API error: {}", e))?;

    if !response.status().is_success() {
        let body = response.text().await.unwrap_or_default();
        return Err(format!("Bedrock API error: {}", body));
    }

    let data: serde_json::Value = response.json().await.map_err(|e| format!("Parse: {}", e))?;
    let text = data["content"][0]["text"]
        .as_str()
        .unwrap_or("")
        .trim()
        .to_string();

    log::info!("[bedrock] Refined: \"{}\"", text);
    Ok(text)
}
