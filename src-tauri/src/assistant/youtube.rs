//! YouTube search for Duck's music and video tools (step H3).
//!
//! YouTube Music has no playback API, so playing is opening a link on the target
//! (the engine's side); this is the search, through the YouTube Data API with the
//! key `duck/youtube-api-key`, so the key stays out of the webview. A search is
//! `search.list` (100 units of the 10,000 free a day) for the ids, then
//! `videos.list` (1 unit) for each video's plain title, channel and length. Every
//! search's units go in `assistant_quota`, for the spend line's "today".

use std::sync::Arc;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::State;

use super::budget::record_quota;
use super::google::form_body;
use super::{key, now_ms, Assistant};

const API: &str = "https://www.googleapis.com/youtube/v3";
/// What one search costs: `search.list` and `videos.list`.
const SEARCH_UNITS: i64 = 101;
/// YouTube's "Music" video category.
const MUSIC_CATEGORY: &str = "10";

#[derive(Debug, Clone, Copy, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Music,
    Video,
}

/// A video the search found.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Item {
    pub id: String,
    pub title: String,
    /// The channel, without the " - Topic" of an artist's auto-generated one.
    pub channel: String,
    /// Length in seconds; 0 for a live stream.
    pub seconds: u64,
    pub live: bool,
}

/// An ISO 8601 duration as YouTube gives it (`PT1H2M3S`, `P1DT2H`), in seconds.
pub fn duration(iso: &str) -> u64 {
    let mut total = 0;
    let mut n = 0;
    for c in iso.chars() {
        match c {
            '0'..='9' => n = n * 10 + u64::from(c as u8 - b'0'),
            'W' => (total, n) = (total + n * 604_800, 0),
            'D' => (total, n) = (total + n * 86_400, 0),
            'H' => (total, n) = (total + n * 3_600, 0),
            'M' => (total, n) = (total + n * 60, 0),
            'S' => (total, n) = (total + n, 0),
            _ => n = 0,
        }
    }
    total
}

/// The items of a `videos.list` answer, in the order of `ids`.
pub fn items(videos: &Value, ids: &[String]) -> Vec<Item> {
    let all = videos["items"].as_array().cloned().unwrap_or_default();
    ids.iter()
        .filter_map(|id| {
            let v = all.iter().find(|v| v["id"].as_str() == Some(id))?;
            let s = &v["snippet"];
            let channel = s["channelTitle"].as_str().unwrap_or_default();
            Some(Item {
                id: id.clone(),
                title: s["title"].as_str()?.to_string(),
                channel: channel.strip_suffix(" - Topic").unwrap_or(channel).to_string(),
                seconds: duration(v["contentDetails"]["duration"].as_str().unwrap_or_default()),
                live: s["liveBroadcastContent"].as_str() == Some("live"),
            })
        })
        .collect()
}

/// The reason in an error answer, said plainly for the quota.
fn reason(status: reqwest::StatusCode, body: &str) -> String {
    let v: Value = serde_json::from_str(body).unwrap_or_default();
    let why = v["error"]["errors"][0]["reason"].as_str().unwrap_or_default();
    if why == "quotaExceeded" || why == "dailyLimitExceeded" {
        return "the YouTube Data API's free daily quota is used up; it resets at midnight Pacific time".into();
    }
    let msg = v["error"]["message"].as_str().unwrap_or(body);
    format!("the YouTube Data API answered {status}: {msg}")
}

async fn get(client: &reqwest::Client, path: &str, query: &[(&str, &str)]) -> Result<Value, String> {
    let r = client
        .get(format!("{API}/{path}?{}", form_body(query)))
        .send()
        .await
        .map_err(|e| format!("the YouTube Data API: {}", e.without_url()))?;
    let status = r.status();
    let text = r.text().await.map_err(|e| format!("the YouTube Data API: {}", e.without_url()))?;
    if !status.is_success() {
        return Err(reason(status, &text));
    }
    serde_json::from_str(&text).map_err(|e| format!("the YouTube Data API: {e}"))
}

/// Up to eight videos for `query`; `music` keeps to YouTube's Music category.
#[tauri::command]
pub async fn assistant_youtube_search(
    ctx: State<'_, Arc<Assistant>>,
    query: String,
    kind: Kind,
) -> Result<Vec<Item>, String> {
    let key = key::youtube_api().ok_or(
        "no YouTube Data API key: create one in a Google Cloud project with the YouTube Data API v3 enabled, \
         and store it with `cmdkey /generic:duck/youtube-api-key /user:duck /pass:<key>`",
    )?;
    let client = reqwest::Client::new();
    let mut q = vec![
        ("part", "id"),
        ("type", "video"),
        ("maxResults", "8"),
        ("q", query.as_str()),
        ("key", key.as_str()),
    ];
    if kind == Kind::Music {
        q.push(("videoCategoryId", MUSIC_CATEGORY));
    }
    let found = get(&client, "search", &q).await?;
    let ids: Vec<String> = found["items"]
        .as_array()
        .map(|a| a.iter().filter_map(|i| i["id"]["videoId"].as_str().map(String::from)).collect())
        .unwrap_or_default();
    let videos = if ids.is_empty() {
        Value::Null
    } else {
        let joined = ids.join(",");
        get(&client, "videos", &[("part", "snippet,contentDetails"), ("id", joined.as_str()), ("key", key.as_str())]).await?
    };
    {
        let conn = ctx.db.conn.lock().expect("duck db lock poisoned");
        record_quota(&conn, now_ms(), "youtube", SEARCH_UNITS).map_err(|e| e.to_string())?;
    }
    Ok(items(&videos, &ids))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn reads_youtube_durations() {
        assert_eq!(duration("PT3M45S"), 225);
        assert_eq!(duration("PT1H2M3S"), 3_723);
        assert_eq!(duration("PT45S"), 45);
        assert_eq!(duration("P1DT2H"), 93_600);
        assert_eq!(duration("P0D"), 0);
        assert_eq!(duration(""), 0);
    }

    #[test]
    fn keeps_the_searchs_order_and_names_the_artist() {
        let videos = json!({"items": [
            {"id": "b", "snippet": {"title": "Lo-fi radio", "channelTitle": "Lofi Girl", "liveBroadcastContent": "live"},
             "contentDetails": {"duration": "P0D"}},
            {"id": "a", "snippet": {"title": "Bohemian Rhapsody", "channelTitle": "Queen - Topic", "liveBroadcastContent": "none"},
             "contentDetails": {"duration": "PT5M55S"}},
        ]});
        let got = items(&videos, &["a".into(), "gone".into(), "b".into()]);
        assert_eq!(
            got,
            vec![
                Item { id: "a".into(), title: "Bohemian Rhapsody".into(), channel: "Queen".into(), seconds: 355, live: false },
                Item { id: "b".into(), title: "Lo-fi radio".into(), channel: "Lofi Girl".into(), seconds: 0, live: true },
            ]
        );
    }

    #[test]
    fn says_when_the_quota_is_used_up() {
        let body = r#"{"error": {"code": 403, "message": "The request cannot be completed", "errors": [{"reason": "quotaExceeded"}]}}"#;
        assert!(reason(reqwest::StatusCode::FORBIDDEN, body).contains("free daily quota is used up"));
        let bad = r#"{"error": {"code": 400, "message": "API key not valid", "errors": [{"reason": "badRequest"}]}}"#;
        assert_eq!(reason(reqwest::StatusCode::BAD_REQUEST, bad), "the YouTube Data API answered 400 Bad Request: API key not valid");
    }
}
