//! Usage-limit meter via a managed statusline (step 3.2).
//!
//! Account-wide rate-limit data (the rolling 5-hour and weekly windows) is exposed
//! by Claude Code only through the JSON it pipes to a **custom statusline command**
//! (design §4.5, decision 17) — hook payloads carry none of it. So Workbench installs
//! a tiny **managed statusline script** at user level that:
//!
//! 1. forwards that JSON to this process's local server ([`ingest`]), and
//! 2. prints a useful status line — chaining the user's prior statusline if they had
//!    one, so installing ours is never a downgrade.
//!
//! The ingest side keeps a single **account-global** snapshot ([`LimitsState`]) — every
//! session reports the same `rate_limits`, so the newest POST (from any session, even a
//! `claude` run outside Workbench) wins, and the app shows one header/tray meter. Unlike
//! hook events this is *not* session-filtered: the figures are the same for every
//! session, foreign or not.

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::db::Db;

/// The Tauri event carrying a fresh account-wide limits snapshot to the frontend.
const LIMITS_EVENT: &str = "usage-limits-updated";

/// Route the managed statusline POSTs its JSON to. Shared by the dev and release
/// builds — they listen on different ports, so the same path is unambiguous (cf. the
/// hook path, which must differ because both builds' hooks coexist in one settings
/// file). Mounted by the hook server (`hooks::server`).
pub const INGEST_PATH: &str = "/__workbench_statusline";

/// Filename of the managed script under `~/.claude/`. The dev build uses a distinct
/// name so a `tauri dev` run and an installed release don't overwrite each other's
/// script file — though only one can own the single `statusLine` settings key at a
/// time (see [`install`]).
const SCRIPT_NAME: &str = if cfg!(debug_assertions) {
    "workbench-statusline.dev.mjs"
} else {
    "workbench-statusline.mjs"
};

/// `meta` key under which a pre-existing *foreign* statusline command is persisted so
/// our script can chain it across relaunches (decision 17: don't clobber the user's).
const CHAINED_KEY: &str = "statusline_chained_cmd";

/// One rolling usage window (5-hour or weekly): how much of the account's allowance is
/// spent and when it resets. `resets_at` is epoch seconds, so the UI can show a live
/// countdown.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RateWindow {
    pub used_percentage: f64,
    pub resets_at: i64,
}

impl RateWindow {
    /// Parse one window object; `None` if absent or missing its percentage (an absent
    /// window is normal — either rolling window may not be reported yet).
    fn parse(v: Option<&Value>) -> Option<Self> {
        let v = v?;
        let used_percentage = v.get("used_percentage").and_then(Value::as_f64)?;
        let resets_at = v.get("resets_at").and_then(Value::as_i64).unwrap_or(0);
        Some(Self {
            used_percentage,
            resets_at,
        })
    }
}

/// The account-wide rate-limit snapshot surfaced to the UI. Both windows are optional
/// — they appear only after the first API response, and on Pro/Max only.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RateLimits {
    pub five_hour: Option<RateWindow>,
    pub seven_day: Option<RateWindow>,
    /// When Workbench received this snapshot (epoch seconds), for an "as of" hint.
    pub received_at: i64,
}

impl RateLimits {
    fn parse(rl: &Value) -> Self {
        Self {
            five_hour: RateWindow::parse(rl.get("five_hour")),
            seven_day: RateWindow::parse(rl.get("seven_day")),
            received_at: now(),
        }
    }

    fn is_empty(&self) -> bool {
        self.five_hour.is_none() && self.seven_day.is_none()
    }
}

/// The latest account-wide limits, managed by Tauri. One slot, last-write-wins, since
/// every session reports the same figures.
#[derive(Default)]
pub struct LimitsState(pub Mutex<Option<RateLimits>>);

/// Fold one statusline POST into the global snapshot and notify the frontend. Pure
/// observation: any malformed or empty payload is silently ignored (older clients, or
/// a session before its first API response, carry no `rate_limits`).
pub fn ingest(app: &AppHandle, body: &[u8]) {
    let Ok(v) = serde_json::from_slice::<Value>(body) else {
        return;
    };
    let Some(rl) = v.get("rate_limits") else {
        return;
    };
    let limits = RateLimits::parse(rl);
    if limits.is_empty() {
        return;
    }
    if let Some(state) = app.try_state::<LimitsState>() {
        if let Ok(mut guard) = state.0.lock() {
            *guard = Some(limits.clone());
        }
    }
    let _ = app.emit(LIMITS_EVENT, limits);
}

/// The current account-wide limits (or `None` until the first statusline POST). Read
/// once on launch so the meter isn't blank until the next session refreshes it.
#[tauri::command]
pub fn usage_limits(state: State<'_, LimitsState>) -> Option<RateLimits> {
    state.0.lock().ok().and_then(|g| g.clone())
}

/// Install (or refresh) the managed statusline pointing at `port`. Writes the script
/// under `~/.claude/` and points `~/.claude/settings.json`'s `statusLine` at it,
/// chaining any pre-existing user command. Idempotent on relaunch: the settings entry
/// is stable (the port lives inside the script, not the command), so only the script
/// file is rewritten when the port changes. Errors are returned for the caller to log
/// — a failed install only costs the usage meter, never the app.
pub fn install(app: &AppHandle, port: u16) -> Result<(), String> {
    let db = app.state::<Db>();
    let settings_path = crate::hooks::install::settings_path()?;
    let mut settings = crate::hooks::install::read_settings(&settings_path)?;

    // Capture a pre-existing *foreign* statusline so we can chain it. One-shot and
    // persisted: our own command is never mistaken for a foreign one (so re-running
    // doesn't capture ourselves), and a captured command survives relaunches.
    if let Some(cmd) = settings
        .get("statusLine")
        .and_then(|s| s.get("command"))
        .and_then(Value::as_str)
    {
        if !is_ours(cmd) {
            let _ = db.meta_set(CHAINED_KEY, cmd);
        }
    }
    let chained = db.meta_get(CHAINED_KEY).ok().flatten();

    // Write the managed script (always overwritten — its content is deterministic for
    // a given port + chained command).
    let script = script_path()?;
    let url = format!("http://127.0.0.1:{port}{INGEST_PATH}");
    write_script(&script, &render_script(&url, chained.as_deref()))?;

    // Point `statusLine` at our script, preserving every other settings key. Skip the
    // write when it already matches (the common case on relaunch).
    let command = format!("node \"{}\"", script.display());
    let entry = json!({ "type": "command", "command": command });
    let root = settings
        .as_object_mut()
        .ok_or("settings root is not an object")?;
    if root.get("statusLine") == Some(&entry) {
        return Ok(());
    }
    root.insert("statusLine".into(), entry);
    crate::hooks::install::write_settings(&settings_path, &settings)?;
    Ok(())
}

/// The managed statusline body, with the live POST URL and the (JSON-encoded) chained
/// command substituted in. Kept as a literal with `__TOKEN__` markers rather than a
/// `format!` so the embedded JavaScript's own braces need no escaping.
fn render_script(url: &str, chained: Option<&str>) -> String {
    let chained_json = serde_json::to_string(&chained).unwrap_or_else(|_| "null".into());
    SCRIPT
        .replace("__POST_URL__", url)
        .replace("__CHAINED__", &chained_json)
}

/// True when a statusline command is one Workbench manages (matches both the dev and
/// release script names), so we never chain our own command into itself.
fn is_ours(command: &str) -> bool {
    command.contains("workbench-statusline")
}

/// `~/.claude/<script>`.
fn script_path() -> Result<PathBuf, String> {
    let home = std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .ok_or("no home directory (USERPROFILE/HOME unset)")?;
    Ok(PathBuf::from(home).join(".claude").join(SCRIPT_NAME))
}

/// Write the script atomically (temp file + rename), creating `~/.claude` if needed —
/// the same crash-safe pattern the hook installer uses for settings.json.
fn write_script(path: &Path, body: &str) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("creating {}: {e}", dir.display()))?;
    }
    let tmp = path.with_extension("mjs.wbtmp");
    std::fs::write(&tmp, body).map_err(|e| format!("writing {}: {e}", tmp.display()))?;
    std::fs::rename(&tmp, path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("replacing {}: {e}", path.display())
    })
}

fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// The managed statusline, as JavaScript run by Node (which Claude Code already
/// requires, so it's the one interpreter we can rely on cross-platform). `__POST_URL__`
/// and `__CHAINED__` are substituted at install time. The script forwards the
/// statusline JSON to Workbench, then prints either the chained user statusline's
/// output or our own compact line.
const SCRIPT: &str = r##"#!/usr/bin/env node
// Managed by Workbench (step 3.2) — regenerated on each launch; edits are overwritten.
// Receives Claude Code's statusline JSON on stdin, forwards `rate_limits` to the local
// Workbench server (for the account-wide usage meter), then prints a status line. Any
// statusline you had before is chained below, so nothing is lost.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const POST_URL = "__POST_URL__";
const CHAINED = __CHAINED__;

let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => { raw += c; });
process.stdin.on("end", () => { void main(raw); });

async function main(raw) {
  // 1) Forward to Workbench. Fire-and-forget with a short timeout; if Workbench isn't
  //    running the localhost connection is refused immediately, so normal `claude` use
  //    outside Workbench isn't slowed.
  try {
    await fetch(POST_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: raw,
      signal: AbortSignal.timeout(600),
    });
  } catch {}
  // 2) Render the line: chain a prior user statusline if present, else our own.
  if (CHAINED) {
    const r = spawnSync(CHAINED, { input: raw, shell: true, encoding: "utf8" });
    process.stdout.write(r.stdout ?? "");
  } else {
    process.stdout.write(renderLine(raw));
  }
}

function renderLine(raw) {
  let d = {};
  try { d = JSON.parse(raw); } catch {}
  const parts = [];
  const model = (d && d.model && (d.model.display_name || d.model.id)) || null;
  if (model) parts.push(model);
  const branch = gitBranch((d && d.workspace && d.workspace.current_dir) || (d && d.cwd));
  if (branch) parts.push(branch);
  const cost = d && d.cost && d.cost.total_cost_usd;
  if (typeof cost === "number" && cost > 0) parts.push("$" + cost.toFixed(2));
  return parts.join("  ·  ");
}

// Cheap branch read: walk up a few levels for a `.git`, resolve HEAD (handling a
// worktree's `.git` file that points at the real gitdir). Best-effort; null on a miss.
function gitBranch(dir) {
  if (!dir) return null;
  let d = dir;
  for (let i = 0; i < 6 && d; i++) {
    const head = readGitHead(d);
    if (head) return head;
    const up = join(d, "..");
    if (up === d) break;
    d = up;
  }
  return null;
}

function readGitHead(dir) {
  const gitPath = join(dir, ".git");
  let gitDir = gitPath;
  let pointer = null;
  try { pointer = readFileSync(gitPath, "utf8"); } catch {}
  if (pointer && pointer.startsWith("gitdir:")) {
    gitDir = pointer.slice(7).trim();
  }
  let head;
  try { head = readFileSync(join(gitDir, "HEAD"), "utf8").trim(); } catch { return null; }
  const m = head.match(/^ref:\s*refs\/heads\/(.+)$/);
  return m ? m[1] : head.slice(0, 7);
}
"##;

#[cfg(test)]
mod tests {
    use super::*;

    /// Both rolling windows parse, carrying percentage + reset epoch.
    #[test]
    fn parses_both_windows() {
        let rl = json!({
            "five_hour": { "used_percentage": 23.5, "resets_at": 1738425600_i64 },
            "seven_day": { "used_percentage": 41.2, "resets_at": 1738857600_i64 }
        });
        let limits = RateLimits::parse(&rl);
        let five = limits.five_hour.unwrap();
        assert_eq!(five.used_percentage, 23.5);
        assert_eq!(five.resets_at, 1738425600);
        assert_eq!(limits.seven_day.unwrap().used_percentage, 41.2);
    }

    /// The full statusline payload the managed script POSTs (rate_limits nested under
    /// the top-level object, alongside model/cost) yields both windows — the exact
    /// extraction `ingest` performs before handing off to `parse`.
    #[test]
    fn extracts_from_full_statusline_payload() {
        let payload = json!({
            "model": { "id": "claude-opus-4-8", "display_name": "Opus" },
            "cost": { "total_cost_usd": 0.42 },
            "rate_limits": {
                "five_hour": { "used_percentage": 41.0, "resets_at": 1781215663_i64 },
                "seven_day": { "used_percentage": 18.3, "resets_at": 1781608663_i64 }
            }
        });
        let rl = payload.get("rate_limits").expect("rate_limits present");
        let limits = RateLimits::parse(rl);
        assert_eq!(limits.five_hour.unwrap().used_percentage, 41.0);
        assert_eq!(limits.seven_day.unwrap().resets_at, 1781608663);
    }

    /// A missing window is `None`, not an error — either window may be absent.
    #[test]
    fn missing_window_is_none() {
        let rl = json!({ "five_hour": { "used_percentage": 10.0, "resets_at": 1 } });
        let limits = RateLimits::parse(&rl);
        assert!(limits.five_hour.is_some());
        assert!(limits.seven_day.is_none());
        assert!(!limits.is_empty());
    }

    /// `rate_limits` present but carrying neither window is treated as empty (ignored
    /// by `ingest`, so we don't overwrite a good snapshot with nothing).
    #[test]
    fn empty_rate_limits_is_empty() {
        assert!(RateLimits::parse(&json!({})).is_empty());
    }

    /// Our own command is recognised so a re-install never chains us into ourselves;
    /// a genuine foreign command is not ours and gets chained.
    #[test]
    fn ours_detection() {
        assert!(is_ours("node \"C:\\Users\\me\\.claude\\workbench-statusline.mjs\""));
        assert!(is_ours("node ~/.claude/workbench-statusline.dev.mjs"));
        assert!(!is_ours("~/.local/bin/my-statusline.sh"));
    }

    /// The script template substitutes the URL and JSON-encodes the chained command,
    /// quoting/escaping it safely (so a Windows path with backslashes can't break the
    /// generated JavaScript).
    #[test]
    fn render_substitutes_url_and_chained() {
        let out = render_script("http://127.0.0.1:48970/__workbench_statusline", None);
        assert!(out.contains("const POST_URL = \"http://127.0.0.1:48970/__workbench_statusline\""));
        assert!(out.contains("const CHAINED = null;"));
        assert!(!out.contains("__POST_URL__"));

        let out = render_script("http://x", Some(r#"node "C:\tools\sl.mjs""#));
        // serde_json encodes the backslashes + quotes into a valid JS string literal.
        assert!(out.contains(r#"const CHAINED = "node \"C:\\tools\\sl.mjs\"";"#));
    }
}
