//! The trust replay's input (step T2): the tool calls Claude Code sessions made in
//! the past days, read from their transcripts, with what became of each (it ran,
//! you rejected it, a permission mode denied it) and the prompts around it. The
//! webview runs them through the trust policy and compares (`trust/replay.ts`).
//!
//! Read-only: it streams `~/.claude/projects/*/*.jsonl` (and the subagent files
//! under them) touched in the window, and parses only the lines that can carry a
//! tool call, its result or a prompt.

use std::collections::HashMap;
use std::fs::File;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use serde::Serialize;
use serde_json::Value;

/// Tools that never prompt, or whose prompt is a question or a plan (T3's).
const SKIP: &[&str] = &[
    "Read", "Glob", "Grep", "LS", "TodoWrite", "TodoRead", "Task", "Agent", "ToolSearch",
    "AskUserQuestion", "ExitPlanMode", "EnterPlanMode", "Skill", "SlashCommand",
    "BashOutput", "KillShell", "TaskOutput", "TaskStop", "ListMcpResourcesTool",
    "ReadMcpResourceTool", "Monitor", "ScheduleWakeup", "SendMessage",
];
/// Long strings in an input (a file's content) are cut to this many characters.
const FIELD_MAX: usize = 1500;
const PROMPT_MAX: usize = 2000;

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ReplayCall {
    pub session_id: String,
    pub cwd: String,
    /// Epoch ms (0 when the line had no timestamp).
    pub ts: i64,
    pub tool: String,
    pub input: Value,
    /// `ran`, `rejected` (you said no), `denied` (a permission mode or rule said
    /// no), `error` (it ran and failed), or `none` (no result was seen).
    pub outcome: String,
    /// The conversation's first prompt, and the latest one before the call.
    pub first_prompt: Option<String>,
    pub last_prompt: Option<String>,
    /// The permission mode at the call (`default`, `auto`, `acceptEdits`, …).
    pub mode: Option<String>,
}

fn cut(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    let head: String = s.chars().take(max).collect();
    format!("{head}… [cut]")
}

fn cut_value(v: &Value, depth: usize) -> Value {
    match v {
        Value::String(s) => Value::String(cut(s, FIELD_MAX)),
        Value::Array(a) if depth < 4 => Value::Array(a.iter().take(20).map(|x| cut_value(x, depth + 1)).collect()),
        Value::Object(o) if depth < 4 => Value::Object(
            o.iter().map(|(k, x)| (k.clone(), cut_value(x, depth + 1))).collect(),
        ),
        Value::Array(_) | Value::Object(_) => Value::String("…".into()),
        other => other.clone(),
    }
}

fn text_of(content: &Value) -> String {
    match content {
        Value::String(s) => s.clone(),
        Value::Array(blocks) => blocks
            .iter()
            .filter_map(|b| b.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

/// What a tool result says became of its call.
/// Only an error result that *starts* with Claude Code's own wording counts: a
/// command's output can contain the same words (a grep for them).
pub fn outcome_of(result: &Value) -> &'static str {
    if result.get("is_error").and_then(Value::as_bool) != Some(true) {
        return "ran";
    }
    let text = text_of(result.get("content").unwrap_or(&Value::Null));
    let t = text.trim_start();
    if t.starts_with("The user doesn't want to proceed with this tool use")
        || t.starts_with("The user doesn't want to take this action")
    {
        return "rejected";
    }
    if (t.starts_with("Permission to use") || t.starts_with("Permission for this")) && t.contains("denied") {
        return "denied";
    }
    "error"
}

/// A prompt the user typed: not a tool result, not a note for the model, not a
/// command's wrapper.
fn user_prompt(line: &Value) -> Option<String> {
    if line.get("isMeta").and_then(Value::as_bool) == Some(true)
        || line.get("isCompactSummary").and_then(Value::as_bool) == Some(true)
    {
        return None;
    }
    let content = line.get("message")?.get("content")?;
    if let Value::Array(blocks) = content {
        if blocks.iter().any(|b| b.get("type").and_then(Value::as_str) == Some("tool_result")) {
            return None;
        }
    }
    let text = text_of(content);
    let t = text.trim();
    if t.is_empty() || t.starts_with('<') || t.starts_with("[Request interrupted") {
        return None;
    }
    Some(cut(t, PROMPT_MAX))
}

/// `2026-10-20T10:00:01.234Z` (UTC, as Claude Code writes it) → epoch ms.
fn parse_ts(s: &str) -> Option<i64> {
    let b = s.as_bytes();
    if b.len() < 20 || b[4] != b'-' || b[7] != b'-' || b[10] != b'T' || !s.ends_with('Z') {
        return None;
    }
    let num = |r: std::ops::Range<usize>| s.get(r)?.parse::<i64>().ok();
    let (y, m, d) = (num(0..4)?, num(5..7)?, num(8..10)?);
    let (hh, mm, ss) = (num(11..13)?, num(14..16)?, num(17..19)?);
    let ms = match s.get(19..s.len() - 1) {
        Some(f) if f.starts_with('.') && f.len() > 1 => {
            let digits: String = f[1..].chars().take(3).collect();
            digits.parse::<i64>().ok()? * 10_i64.pow(3 - digits.len() as u32)
        }
        _ => 0,
    };
    // Days from the civil date (Howard Hinnant's algorithm).
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    Some(((days * 24 + hh) * 60 + mm) * 60_000 + ss * 1000 + ms)
}

fn ts_of(line: &Value) -> i64 {
    line.get("timestamp").and_then(Value::as_str).and_then(parse_ts).unwrap_or(0)
}

/// The calls in one transcript, in order.
pub fn scan_file(path: &Path) -> Vec<ReplayCall> {
    let Ok(file) = File::open(path) else { return Vec::new() };
    let session_id = path.file_stem().and_then(|s| s.to_str()).unwrap_or("").to_string();
    let mut calls: Vec<ReplayCall> = Vec::new();
    let mut by_id: HashMap<String, usize> = HashMap::new();
    let mut first: Option<String> = None;
    let mut last: Option<String> = None;
    let mut mode: Option<String> = None;
    for raw in BufReader::new(file).lines().map_while(Result::ok) {
        let user = raw.contains("\"type\":\"user\"");
        if !user && !raw.contains("\"tool_use\"") {
            continue;
        }
        let Ok(line) = serde_json::from_str::<Value>(&raw) else { continue };
        if let Some(m) = line.get("permissionMode").and_then(Value::as_str) {
            mode = Some(m.to_string());
        }
        let content = line.get("message").and_then(|m| m.get("content"));
        match line.get("type").and_then(Value::as_str) {
            Some("user") => {
                if let Some(p) = user_prompt(&line) {
                    first.get_or_insert_with(|| p.clone());
                    last = Some(p);
                }
                for b in content.and_then(Value::as_array).into_iter().flatten() {
                    if b.get("type").and_then(Value::as_str) != Some("tool_result") {
                        continue;
                    }
                    let id = b.get("tool_use_id").and_then(Value::as_str).unwrap_or("");
                    if let Some(&i) = by_id.get(id) {
                        calls[i].outcome = outcome_of(b).into();
                    }
                }
            }
            Some("assistant") => {
                for b in content.and_then(Value::as_array).into_iter().flatten() {
                    if b.get("type").and_then(Value::as_str) != Some("tool_use") {
                        continue;
                    }
                    let tool = b.get("name").and_then(Value::as_str).unwrap_or("").to_string();
                    if tool.is_empty() || SKIP.contains(&tool.as_str()) {
                        continue;
                    }
                    let id = b.get("id").and_then(Value::as_str).unwrap_or("").to_string();
                    by_id.insert(id, calls.len());
                    calls.push(ReplayCall {
                        session_id: session_id.clone(),
                        cwd: line.get("cwd").and_then(Value::as_str).unwrap_or("").to_string(),
                        ts: ts_of(&line),
                        tool,
                        input: cut_value(b.get("input").unwrap_or(&Value::Null), 0),
                        outcome: "none".into(),
                        first_prompt: first.clone(),
                        last_prompt: last.clone(),
                        mode: mode.clone(),
                    });
                }
            }
            _ => {}
        }
    }
    calls
}

/// Transcript files under `dir` (two levels: project folders, and their session
/// folders' `subagents/`) modified since `since`.
fn recent_files(dir: &Path, since: SystemTime, depth: usize, out: &mut Vec<PathBuf>) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for e in entries.flatten() {
        let p = e.path();
        let Ok(meta) = e.metadata() else { continue };
        if meta.is_dir() {
            if depth < 3 {
                recent_files(&p, since, depth + 1, out);
            }
        } else if p.extension().is_some_and(|x| x == "jsonl")
            && meta.modified().is_ok_and(|m| m >= since)
        {
            out.push(p);
        }
    }
}

/// The calls of the past `days`, newest last, at most `max` (the newest kept).
pub fn scan(projects_dir: &Path, days: u32, max: usize) -> Vec<ReplayCall> {
    let since = SystemTime::now() - Duration::from_secs(u64::from(days) * 86_400);
    let since_ms = since.duration_since(SystemTime::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0);
    let mut files = Vec::new();
    recent_files(projects_dir, since, 0, &mut files);
    let mut calls: Vec<ReplayCall> = files.iter().flat_map(|f| scan_file(f)).filter(|c| c.ts >= since_ms).collect();
    calls.sort_by_key(|c| c.ts);
    if calls.len() > max {
        calls.drain(..calls.len() - max);
    }
    calls
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn reads_calls_outcomes_and_prompts() {
        let dir = std::env::temp_dir().join(format!("wb-replay-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("abc.jsonl");
        let lines = [
            json!({"type":"user","permissionMode":"default","timestamp":"2026-10-20T10:00:00Z","message":{"role":"user","content":"fix the auth test"}}),
            json!({"type":"assistant","cwd":"C:\\src\\app","timestamp":"2026-10-20T10:00:01Z","message":{"content":[
                {"type":"tool_use","id":"t1","name":"Bash","input":{"command":"npm test"}},
                {"type":"tool_use","id":"t2","name":"Read","input":{"file_path":"x"}},
                {"type":"tool_use","id":"t3","name":"Write","input":{"file_path":"y","content":"z".repeat(5000)}}]}}),
            json!({"type":"user","message":{"content":[
                {"type":"tool_result","tool_use_id":"t1","content":"ok"},
                {"type":"tool_result","tool_use_id":"t3","is_error":true,"content":"The user doesn't want to proceed with this tool use. The tool use was rejected"}]}}),
            json!({"type":"user","isMeta":true,"message":{"content":"<local-command-caveat>x</local-command-caveat>"}}),
            json!({"type":"user","message":{"content":"now push it"}}),
            json!({"type":"assistant","cwd":"C:\\src\\app","timestamp":"2026-10-20T10:01:00Z","message":{"content":[
                {"type":"tool_use","id":"t4","name":"Bash","input":{"command":"git push"}}]}}),
            json!({"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t4","is_error":true,"content":[{"type":"text","text":"Permission to use Bash has been denied because Claude Code is running in don't ask mode."}]}]}}),
            // Output that merely quotes the wording is a run, not a rejection.
            json!({"type":"assistant","cwd":"C:\\src\\app","timestamp":"2026-10-20T10:02:00Z","message":{"content":[
                {"type":"tool_use","id":"t5","name":"Bash","input":{"command":"grep -r \"want to proceed\" ."}}]}}),
            json!({"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t5","content":"x.jsonl: The user doesn't want to proceed with this tool use."}]}}),
        ];
        std::fs::write(&path, lines.iter().map(|l| l.to_string()).collect::<Vec<_>>().join("\n")).unwrap();
        let calls = scan_file(&path);
        std::fs::remove_dir_all(&dir).ok();
        let got: Vec<_> = calls.iter().map(|c| (c.tool.as_str(), c.outcome.as_str(), c.last_prompt.as_deref())).collect();
        assert_eq!(
            got,
            [
                ("Bash", "ran", Some("fix the auth test")),
                ("Write", "rejected", Some("fix the auth test")),
                ("Bash", "denied", Some("now push it")),
                ("Bash", "ran", Some("now push it")),
            ]
        );
        assert_eq!(calls[0].session_id, "abc");
        assert_eq!(calls[0].cwd, "C:\\src\\app");
        assert_eq!(calls[0].mode.as_deref(), Some("default"));
        assert_eq!(calls[2].first_prompt.as_deref(), Some("fix the auth test"));
        assert!(calls[1].input["content"].as_str().unwrap().len() < 1600);
        assert_eq!(calls[0].ts, parse_ts("2026-10-20T10:00:01Z").unwrap());
    }

    /// By hand: `WB_REPLAY_OUT=<file> cargo test --lib replay::tests::dump_the_past_week -- --ignored`
    /// writes the past week's calls as JSON, for running the replay outside the app.
    #[test]
    #[ignore]
    fn dump_the_past_week() {
        let out = std::env::var("WB_REPLAY_OUT").expect("set WB_REPLAY_OUT");
        let dir = crate::transcript::claude_projects_dir().unwrap();
        let start = std::time::Instant::now();
        let calls = scan(&dir, 7, 20_000);
        eprintln!("{} calls in {:?}", calls.len(), start.elapsed());
        std::fs::write(out, serde_json::to_string(&calls).unwrap()).unwrap();
    }

    #[test]
    fn parses_claude_code_timestamps() {
        assert_eq!(parse_ts("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(parse_ts("2026-10-20T10:00:01.234Z"), Some(1_792_490_401_234));
        assert_eq!(parse_ts("2000-03-01T00:00:00.5Z"), Some(951_868_800_500));
        assert_eq!(parse_ts("not a time"), None);
    }
}
