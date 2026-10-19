//! The usage ledger (step A1): what each proxied call used and cost.
//!
//! The proxy hands every `/v1/messages` response to a [`Meter`], which watches the
//! bytes go by without holding them up. A streamed response reports `usage` in
//! `message_start` and again, cumulatively, in `message_delta`; a plain JSON response
//! carries it on the message. When the response ends (or the caller hangs up) the
//! meter prices what it saw and writes one `assistant_usage` row.

use serde::Serialize;
use serde_json::Value;

/// $ per million tokens, from <https://platform.claude.com/docs/en/about-claude/pricing>
/// (checked 2026-10-19). Cache writes are priced by TTL.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Price {
    pub input: f64,
    pub write_5m: f64,
    pub write_1h: f64,
    pub read: f64,
    pub output: f64,
}

const fn price(input: f64, write_5m: f64, write_1h: f64, read: f64, output: f64) -> Price {
    Price {
        input,
        write_5m,
        write_1h,
        read,
        output,
    }
}

/// Matched by prefix, so dated ids (`…-20261001`) price like their alias. More
/// specific prefixes come first: `claude-opus-5` would also match `claude-opus-5-5`.
const PRICES: &[(&str, Price)] = &[
    ("claude-fable-5-1", price(10.0, 12.5, 20.0, 0.25, 50.0)),
    ("claude-fable-5", price(10.0, 12.5, 20.0, 1.0, 50.0)),
    ("claude-opus-5-5", price(4.0, 5.0, 8.0, 0.20, 20.0)),
    ("claude-opus-5", price(5.0, 6.25, 10.0, 0.50, 25.0)),
    ("claude-opus-4-8", price(5.0, 6.25, 10.0, 0.50, 25.0)),
    ("claude-sonnet-5-5", price(2.0, 2.5, 4.0, 0.10, 10.0)),
    ("claude-sonnet-5", price(2.0, 2.5, 4.0, 0.20, 10.0)),
    ("claude-haiku-5-5", HAIKU_5_5),
];
const HAIKU_5_5: Price = price(0.10, 0.125, 0.20, 0.01, 0.50);
/// Haiku 5.5 is the one model priced by prompt length: a prompt (input + cache
/// writes + cache reads) over 100k tokens pays these for the whole request.
const HAIKU_5_5_LONG: Price = price(0.50, 0.625, 1.0, 0.05, 2.50);
const HAIKU_LONG_PROMPT: u64 = 100_000;
/// An unknown model is priced like the most expensive one, so the budget errs on the
/// side of stopping early.
const FALLBACK: Price = price(10.0, 12.5, 20.0, 1.0, 50.0);
const PER_SEARCH_USD: f64 = 0.01;

/// Token counts as the API reports them on `usage`.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct Usage {
    pub input: u64,
    pub output: u64,
    pub cache_write_5m: u64,
    pub cache_write_1h: u64,
    pub cache_read: u64,
    pub searches: u64,
}

impl Usage {
    /// Fold in a `usage` object. Its counts are cumulative, so a field that's present
    /// replaces what we had and an absent one leaves it.
    pub fn merge(&mut self, u: &Value) {
        let get = |v: &Value, k: &str| v.get(k).and_then(Value::as_u64);
        if let Some(n) = get(u, "input_tokens") {
            self.input = n;
        }
        if let Some(n) = get(u, "output_tokens") {
            self.output = n;
        }
        if let Some(n) = get(u, "cache_read_input_tokens") {
            self.cache_read = n;
        }
        match u.get("cache_creation").filter(|c| c.is_object()) {
            Some(c) => {
                if let Some(n) = get(c, "ephemeral_5m_input_tokens") {
                    self.cache_write_5m = n;
                }
                if let Some(n) = get(c, "ephemeral_1h_input_tokens") {
                    self.cache_write_1h = n;
                }
            }
            // No TTL breakdown: count every write at the 5-minute rate.
            None => {
                if let Some(n) = get(u, "cache_creation_input_tokens") {
                    self.cache_write_5m = n;
                    self.cache_write_1h = 0;
                }
            }
        }
        if let Some(n) = u
            .get("server_tool_use")
            .and_then(|s| get(s, "web_search_requests"))
        {
            self.searches = n;
        }
    }

    pub fn cache_write(&self) -> u64 {
        self.cache_write_5m + self.cache_write_1h
    }

    pub fn is_empty(&self) -> bool {
        *self == Usage::default()
    }
}

pub fn price_for(model: &str, usage: &Usage) -> Price {
    let p = PRICES
        .iter()
        .find(|(prefix, _)| model.starts_with(prefix))
        .map(|(_, p)| *p)
        .unwrap_or(FALLBACK);
    let prompt = usage.input + usage.cache_write() + usage.cache_read;
    if p == HAIKU_5_5 && prompt > HAIKU_LONG_PROMPT {
        HAIKU_5_5_LONG
    } else {
        p
    }
}

pub fn cost_usd(model: &str, u: &Usage) -> f64 {
    let p = price_for(model, u);
    let mtok = |n: u64, rate: f64| n as f64 * rate / 1_000_000.0;
    mtok(u.input, p.input)
        + mtok(u.cache_write_5m, p.write_5m)
        + mtok(u.cache_write_1h, p.write_1h)
        + mtok(u.cache_read, p.read)
        + mtok(u.output, p.output)
        + u.searches as f64 * PER_SEARCH_USD
}

/// One ledger row, as `assistant-usage` events and the spend readout carry it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Record {
    pub ts: i64,
    pub model: String,
    pub purpose: String,
    pub usage: Usage,
    pub cost_usd: f64,
}

pub fn insert(conn: &rusqlite::Connection, r: &Record) -> rusqlite::Result<()> {
    conn.execute(
        r#"INSERT INTO assistant_usage (ts, model, purpose, "in", out, cache_w, cache_r, searches, cost_usd)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)"#,
        rusqlite::params![
            r.ts,
            r.model,
            r.purpose,
            r.usage.input as i64,
            r.usage.output as i64,
            r.usage.cache_write() as i64,
            r.usage.cache_read as i64,
            r.usage.searches as i64,
            r.cost_usd,
        ],
    )?;
    Ok(())
}

/// Watches one response body for `usage`. Feed it every chunk; [`Meter::finish`]
/// returns the totals. Server-sent events are parsed line by line as they arrive;
/// a JSON body is kept (up to a cap) and parsed at the end.
pub struct Meter {
    /// The model the request asked for, until the response names the one that ran.
    pub model: String,
    sse: bool,
    pending: Vec<u8>,
    usage: Usage,
}

/// A JSON message body bigger than this isn't kept; its usage goes unrecorded,
/// which `finish` reports so the caller can say so.
const JSON_CAP: usize = 8 << 20;

impl Meter {
    pub fn new(model: String, sse: bool) -> Self {
        Self {
            model,
            sse,
            pending: Vec::new(),
            usage: Usage::default(),
        }
    }

    pub fn feed(&mut self, chunk: &[u8]) {
        if !self.sse {
            if self.pending.len() + chunk.len() <= JSON_CAP {
                self.pending.extend_from_slice(chunk);
            }
            return;
        }
        self.pending.extend_from_slice(chunk);
        while let Some(nl) = self.pending.iter().position(|&b| b == b'\n') {
            let line: Vec<u8> = self.pending.drain(..=nl).collect();
            self.line(&line);
        }
    }

    fn line(&mut self, line: &[u8]) {
        let Some(data) = line.strip_prefix(b"data:") else {
            return;
        };
        let Ok(v) = serde_json::from_slice::<Value>(data.trim_ascii()) else {
            return;
        };
        match v.get("type").and_then(Value::as_str) {
            Some("message_start") => {
                if let Some(m) = v.get("message") {
                    self.message(m);
                }
            }
            Some("message_delta") => {
                if let Some(u) = v.get("usage") {
                    self.usage.merge(u);
                }
            }
            _ => {}
        }
    }

    fn message(&mut self, m: &Value) {
        if let Some(model) = m.get("model").and_then(Value::as_str) {
            self.model = model.to_string();
        }
        if let Some(u) = m.get("usage") {
            self.usage.merge(u);
        }
    }

    pub fn finish(mut self) -> (String, Usage) {
        if self.sse {
            let rest = std::mem::take(&mut self.pending);
            self.line(&rest);
        } else if let Ok(m) = serde_json::from_slice::<Value>(&self.pending) {
            self.message(&m);
        }
        (self.model, self.usage)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn close(a: f64, b: f64) -> bool {
        (a - b).abs() < 1e-9
    }

    #[test]
    fn meters_a_stream_split_across_chunks() {
        let body = concat!(
            "event: message_start\n",
            r#"data: {"type":"message_start","message":{"model":"claude-sonnet-5-5","usage":{"input_tokens":1000,"cache_creation_input_tokens":3000,"cache_creation":{"ephemeral_5m_input_tokens":0,"ephemeral_1h_input_tokens":3000},"cache_read_input_tokens":5000,"output_tokens":1}}}"#,
            "\n\n",
            "event: content_block_delta\n",
            r#"data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}"#,
            "\n\n",
            "event: message_delta\n",
            r#"data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":200,"server_tool_use":{"web_search_requests":2}}}"#,
            "\n\n",
        );
        let mut m = Meter::new("claude-sonnet-5-5".into(), true);
        for chunk in body.as_bytes().chunks(7) {
            m.feed(chunk);
        }
        let (model, u) = m.finish();
        assert_eq!(model, "claude-sonnet-5-5");
        assert_eq!(
            u,
            Usage {
                input: 1000,
                output: 200,
                cache_write_5m: 0,
                cache_write_1h: 3000,
                cache_read: 5000,
                searches: 2
            }
        );
        // 1000×$2 + 3000×$4 + 5000×$0.10 + 200×$10 per MTok, + 2 searches × $0.01
        assert!(close(
            cost_usd(&model, &u),
            0.002 + 0.012 + 0.0005 + 0.002 + 0.02
        ));
    }

    #[test]
    fn meters_a_json_body() {
        let body = br#"{"id":"m","type":"message","model":"claude-haiku-5-5-20261001","usage":{"input_tokens":12,"output_tokens":1,"cache_creation_input_tokens":0,"cache_read_input_tokens":0}}"#;
        let mut m = Meter::new("claude-haiku-5-5".into(), false);
        m.feed(&body[..20]);
        m.feed(&body[20..]);
        let (model, u) = m.finish();
        assert_eq!(model, "claude-haiku-5-5-20261001");
        assert_eq!((u.input, u.output), (12, 1));
        assert!(close(cost_usd(&model, &u), 12.0 * 0.10 / 1e6 + 0.50 / 1e6));
    }

    #[test]
    fn prices_by_prefix_with_haiku_long_prompts_and_a_safe_fallback() {
        let small = Usage {
            input: 50_000,
            ..Default::default()
        };
        let long = Usage {
            input: 60_000,
            cache_read: 50_000,
            ..Default::default()
        };
        assert_eq!(price_for("claude-opus-5-5", &small).input, 4.0);
        assert_eq!(price_for("claude-opus-5", &small).input, 5.0);
        assert_eq!(price_for("claude-haiku-5-5", &small), HAIKU_5_5);
        assert_eq!(price_for("claude-haiku-5-5", &long), HAIKU_5_5_LONG);
        assert_eq!(price_for("some-new-model", &small), FALLBACK);
    }

    #[test]
    fn a_failed_call_reports_no_usage() {
        let mut m = Meter::new("claude-sonnet-5-5".into(), false);
        m.feed(br#"{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}"#);
        assert!(m.finish().1.is_empty());
    }
}
