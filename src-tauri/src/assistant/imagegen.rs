//! Images from an image model (assistant plan G6): Gemini first, through the
//! Gemini API's Interactions endpoint.
//!
//! - The key is `duck/gemini-api-key` in Credential Manager ([`super::key::gemini_api`]),
//!   stored with `cmdkey`; it never reaches the webview. A Gemini API key is billed
//!   to its Google Cloud project, where a Google AI subscription's developer credits
//!   may apply: that's for you to check in your Google account.
//! - [`generate`] sends the prompt and the reference images (attachments, read from
//!   the store), stores each image that comes back as an attachment, and records it
//!   in `assistant_image_spend` at the model's list price per image.
//! - Image generation has no free tier on the API (pricing page, 2026-10-23).

use std::path::Path;

use base64::Engine as _;
use rusqlite::Connection;
use serde::Serialize;
use serde_json::{json, Value};

use super::attachments::{self, Stored};

pub const ENDPOINT: &str = "https://generativelanguage.googleapis.com/v1beta/interactions";
/// The models Duck offers, the default first.
pub const MODELS: [&str; 3] = ["gemini-nano-banana-2.1", "gemini-3.1-flash-image", "gemini-3-pro-image"];
pub const SIZES: [&str; 3] = ["1K", "2K", "4K"];
pub const ASPECTS: [&str; 10] = ["1:1", "3:2", "2:3", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"];
/// At most this many reference images go with a request (the API takes 14).
pub const MAX_REFS: usize = 10;

/// The list price of one image, USD (pricing page, 2026-10-23).
pub fn price(model: &str, size: &str) -> f64 {
    match (model, size) {
        ("gemini-nano-banana-2.1", "1K") => 0.0336,
        ("gemini-nano-banana-2.1", "2K") => 0.0504,
        ("gemini-nano-banana-2.1", _) => 0.113,
        ("gemini-3.1-flash-image", "1K") => 0.067,
        ("gemini-3.1-flash-image", "2K") => 0.101,
        ("gemini-3.1-flash-image", _) => 0.151,
        ("gemini-3-pro-image", "4K") => 0.24,
        _ => 0.134,
    }
}

/// The request body.
pub fn body(model: &str, prompt: &str, refs: &[(String, Vec<u8>)], aspect: &str, size: &str) -> Value {
    let mut input = vec![json!({ "type": "text", "text": prompt })];
    for (mime, bytes) in refs {
        input.push(json!({
            "type": "image",
            "mime_type": mime,
            "data": base64::engine::general_purpose::STANDARD.encode(bytes),
        }));
    }
    json!({
        "model": model,
        "input": input,
        "response_format": { "type": "image", "mime_type": "image/png", "aspect_ratio": aspect, "image_size": size },
    })
}

/// The images in a response, base64 with their media type: the model's output
/// steps (interim "thought" images are skipped), else `output_image`. And its text.
pub fn images_of(v: &Value) -> (Vec<(String, String)>, String) {
    let mut out = Vec::new();
    let mut text = String::new();
    if let Some(steps) = v.get("steps").and_then(Value::as_array) {
        for s in steps.iter().filter(|s| s["type"] == "model_output") {
            for c in s.get("content").and_then(Value::as_array).into_iter().flatten() {
                match c["type"].as_str() {
                    Some("image") => {
                        if let Some(d) = c["data"].as_str() {
                            out.push((c["mime_type"].as_str().unwrap_or("image/png").to_string(), d.to_string()));
                        }
                    }
                    Some("text") => text.push_str(c["text"].as_str().unwrap_or("")),
                    _ => {}
                }
            }
        }
    }
    if out.is_empty() {
        if let Some(d) = v.pointer("/output_image/data").and_then(Value::as_str) {
            let mime = v.pointer("/output_image/mime_type").and_then(Value::as_str).unwrap_or("image/png");
            out.push((mime.to_string(), d.to_string()));
        }
    }
    if text.is_empty() {
        text = v.get("output_text").and_then(Value::as_str).unwrap_or("").to_string();
    }
    (out, text)
}

/// What a request made.
#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Generated {
    pub images: Vec<Stored>,
    pub model: String,
    pub usd: f64,
    /// What the model said with them (a refusal's reason, say).
    pub text: String,
}

/// A reference image's bytes and media type, from the attachment store.
pub fn reference(root: &Path, id: &str, name: &str) -> Result<(String, Vec<u8>), String> {
    let path = attachments::file_of(root, id, name)?;
    let bytes = std::fs::read(&path).map_err(|e| format!("cannot read {name}: {e}"))?;
    let mime = attachments::mime_of(name, &bytes[..bytes.len().min(64)]);
    if !mime.starts_with("image/") {
        return Err(format!("{name} isn't an image"));
    }
    Ok((mime, bytes))
}

fn reason(status: reqwest::StatusCode, body: &str) -> String {
    let msg = serde_json::from_str::<Value>(body)
        .ok()
        .and_then(|v| v.pointer("/error/message").and_then(Value::as_str).map(str::to_string))
        .unwrap_or_else(|| body.chars().take(300).collect());
    format!("the Gemini API answered {status}: {msg}")
}

/// One request: the images it made, stored, and their price.
pub async fn generate(
    key: &str,
    root: &Path,
    model: &str,
    prompt: &str,
    refs: &[(String, Vec<u8>)],
    aspect: &str,
    size: &str,
    name: &str,
) -> Result<Generated, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(180))
        .build()
        .map_err(|e| e.to_string())?;
    let res = client
        .post(ENDPOINT)
        .header("x-goog-api-key", key)
        .header("content-type", "application/json")
        .body(body(model, prompt, refs, aspect, size).to_string())
        .send()
        .await
        .map_err(|e| format!("the Gemini API couldn't be reached: {e}"))?;
    let status = res.status();
    let text = res.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(reason(status, &text));
    }
    let v: Value = serde_json::from_str(&text).map_err(|e| format!("the Gemini API's answer isn't JSON: {e}"))?;
    let (found, said) = images_of(&v);
    let mut images = Vec::new();
    for (i, (mime, data)) in found.iter().enumerate() {
        let bytes = base64::engine::general_purpose::STANDARD.decode(data).map_err(|e| format!("an image didn't decode: {e}"))?;
        let ext = if mime.contains("jpeg") { "jpg" } else { "png" };
        let file = if found.len() > 1 { format!("{name}-{}.{ext}", i + 1) } else { format!("{name}.{ext}") };
        images.push(attachments::store_bytes(root, &file, &bytes)?);
    }
    let usd = price(model, size) * images.len() as f64;
    Ok(Generated { images, model: model.to_string(), usd, text: said })
}

/// Record images made now.
pub fn record(conn: &Connection, ts: i64, model: &str, images: i64, usd: f64) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO assistant_image_spend (ts, model, images, usd) VALUES (?1, ?2, ?3, ?4)",
        rusqlite::params![ts, model, images, usd],
    )?;
    Ok(())
}

/// This month's images and their cost (local time).
pub fn month(conn: &Connection) -> rusqlite::Result<(i64, f64)> {
    conn.query_row(
        &format!(
            "SELECT COALESCE(SUM(images), 0), COALESCE(SUM(usd), 0) FROM assistant_image_spend WHERE ts >= {}",
            super::budget::MONTH_START
        ),
        [],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_body_carries_the_prompt_the_references_and_the_format() {
        let b = body("gemini-nano-banana-2.1", "three moods", &[("image/png".into(), vec![1, 2, 3])], "1:1", "1K");
        assert_eq!(b["input"][0]["text"], "three moods");
        assert_eq!(b["input"][1]["type"], "image");
        assert_eq!(b["input"][1]["data"], "AQID");
        assert_eq!(b["response_format"]["aspect_ratio"], "1:1");
        assert_eq!(b["response_format"]["image_size"], "1K");
    }

    #[test]
    fn images_come_from_the_model_output_not_its_thoughts() {
        let v = json!({
            "steps": [
                { "type": "thought", "content": [{ "type": "image", "data": "VEhPVUdIVA==" }] },
                { "type": "model_output", "content": [
                    { "type": "text", "text": "Here you go." },
                    { "type": "image", "mime_type": "image/png", "data": "QQ==" }
                ] }
            ],
            "output_image": { "data": "QQ==" }
        });
        let (imgs, text) = images_of(&v);
        assert_eq!(imgs, vec![("image/png".to_string(), "QQ==".to_string())]);
        assert_eq!(text, "Here you go.");
        let (only, said) = images_of(&json!({ "output_image": { "data": "Qg==" }, "output_text": "ok" }));
        assert_eq!((only.len(), said.as_str()), (1, "ok"));
        assert!(images_of(&json!({ "output_text": "I can't draw that." })).0.is_empty());
    }

    #[test]
    fn prices_follow_the_model_and_size() {
        assert_eq!(price("gemini-nano-banana-2.1", "1K"), 0.0336);
        assert_eq!(price("gemini-3-pro-image", "2K"), 0.134);
        assert_eq!(price("gemini-3-pro-image", "4K"), 0.24);
    }

    #[test]
    fn the_month_sums_what_was_recorded() {
        let db = super::super::db::DuckDb::open_in_memory().unwrap();
        let conn = db.conn.lock().unwrap();
        let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as i64;
        record(&conn, now, "gemini-nano-banana-2.1", 3, 0.1008).unwrap();
        record(&conn, now, "gemini-3-pro-image", 1, 0.134).unwrap();
        let (n, usd) = month(&conn).unwrap();
        assert_eq!(n, 4);
        assert!((usd - 0.2348).abs() < 1e-9);
    }
}
