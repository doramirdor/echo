// Minimal AWS Signature Version 4 signer (no AWS SDK dependency).
//
// Mirror of src/main/utils/sigv4.ts. Covers a single signed POST/GET to a
// regional AWS endpoint with static credentials. The path is used verbatim as
// the canonical URI (matching the AWS sig-v4 `get-vanilla` vector and how
// Bedrock model paths are sent). Verified by the test at the bottom of this
// file (`cargo test sigv4`).

use hmac::{Hmac, Mac};
use sha2::{Digest, Sha256};

type HmacSha256 = Hmac<Sha256>;

pub struct SigV4Request<'a> {
    pub method: &'a str,
    pub host: &'a str,
    /// Absolute path, used verbatim as the canonical URI and request path.
    pub path: &'a str,
    pub region: &'a str,
    pub service: &'a str,
    /// Request payload ("" for empty bodies).
    pub body: &'a str,
    pub access_key_id: &'a str,
    pub secret_access_key: &'a str,
    /// Content-Type to sign AND send (e.g. "application/json").
    pub content_type: Option<&'a str>,
    /// Override the timestamp (YYYYMMDDTHHMMSSZ). For testing/determinism.
    pub amz_date: Option<&'a str>,
}

fn sha256_hex(data: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(data);
    hex::encode(hasher.finalize())
}

fn hmac_sha256(key: &[u8], data: &[u8]) -> Vec<u8> {
    let mut mac = HmacSha256::new_from_slice(key).expect("HMAC accepts any key length");
    mac.update(data);
    mac.finalize().into_bytes().to_vec()
}

/// Returns the headers to send (Authorization, X-Amz-Date, and Content-Type if
/// provided). The caller sends these and lets the HTTP client add the Host
/// header (which is part of the signature).
pub fn sign_request(req: &SigV4Request) -> Vec<(String, String)> {
    let amz_date = match req.amz_date {
        Some(d) => d.to_string(),
        None => chrono::Utc::now().format("%Y%m%dT%H%M%SZ").to_string(),
    };
    let date_stamp = &amz_date[..8];

    // Headers that participate in the signature (lowercased names, sorted).
    let mut headers: Vec<(String, String)> = vec![
        ("host".to_string(), req.host.to_string()),
        ("x-amz-date".to_string(), amz_date.clone()),
    ];
    if let Some(ct) = req.content_type {
        headers.push(("content-type".to_string(), ct.to_string()));
    }
    headers.sort_by(|a, b| a.0.cmp(&b.0));

    let canonical_headers: String = headers
        .iter()
        .map(|(n, v)| format!("{}:{}\n", n, v.trim()))
        .collect();
    let signed_headers = headers
        .iter()
        .map(|(n, _)| n.clone())
        .collect::<Vec<_>>()
        .join(";");
    let payload_hash = sha256_hex(req.body.as_bytes());

    let canonical_request = format!(
        "{}\n{}\n{}\n{}\n{}\n{}",
        req.method, req.path, "", canonical_headers, signed_headers, payload_hash
    );

    let scope = format!("{}/{}/{}/aws4_request", date_stamp, req.region, req.service);
    let string_to_sign = format!(
        "AWS4-HMAC-SHA256\n{}\n{}\n{}",
        amz_date,
        scope,
        sha256_hex(canonical_request.as_bytes())
    );

    let k_date = hmac_sha256(format!("AWS4{}", req.secret_access_key).as_bytes(), date_stamp.as_bytes());
    let k_region = hmac_sha256(&k_date, req.region.as_bytes());
    let k_service = hmac_sha256(&k_region, req.service.as_bytes());
    let k_signing = hmac_sha256(&k_service, b"aws4_request");
    let signature = hex::encode(hmac_sha256(&k_signing, string_to_sign.as_bytes()));

    let authorization = format!(
        "AWS4-HMAC-SHA256 Credential={}/{}, SignedHeaders={}, Signature={}",
        req.access_key_id, scope, signed_headers, signature
    );

    let mut out = vec![
        ("X-Amz-Date".to_string(), amz_date),
        ("Authorization".to_string(), authorization),
    ];
    if let Some(ct) = req.content_type {
        out.push(("Content-Type".to_string(), ct.to_string()));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn get_vanilla_vector() {
        // Official AWS sig-v4-test-suite `get-vanilla` vector.
        let headers = sign_request(&SigV4Request {
            method: "GET",
            host: "example.amazonaws.com",
            path: "/",
            region: "us-east-1",
            service: "service",
            body: "",
            access_key_id: "AKIDEXAMPLE",
            secret_access_key: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
            content_type: None,
            amz_date: Some("20150830T123600Z"),
        });
        let auth = headers.iter().find(|(k, _)| k == "Authorization").map(|(_, v)| v.clone()).unwrap();
        assert_eq!(
            auth,
            "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, \
             SignedHeaders=host;x-amz-date, \
             Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31"
        );
    }
}
