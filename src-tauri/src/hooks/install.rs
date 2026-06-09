//! Hook installation into `~/.claude/settings.json` (step 2.1).
//!
//! Writes `http`-type hooks at **user level** (decision 10) so every working dir —
//! project roots *and* the worktree dirs that Phase 2.4 provisions — is covered by
//! one install. The install is:
//!
//! - **Idempotent.** Our entries are identified by a sentinel URL path
//!   ([`HOOK_PATH`]), not by exact URL, so a re-run (even after the port changed)
//!   removes the stale Workbench entry and writes a fresh one — never a duplicate.
//! - **Non-clobbering.** Foreign hooks (anything whose URL isn't ours) are left
//!   untouched; we only ever add/replace our own single entry per event.
//! - **Safe.** A settings file that won't parse is treated as a hard error and left
//!   alone rather than overwritten, so we can't corrupt a user's config.
//!
//! The events we subscribe to are the §4.4 subset the status engine acts on.

use std::path::{Path, PathBuf};

use serde_json::{json, Map, Value};

/// Sentinel path on our local endpoint. Used both as the route the server listens
/// on and as the marker that identifies "our" hooks in settings.json regardless of
/// which port we ended up binding.
///
/// A debug build uses a distinct path so a release and a `tauri dev` instance can
/// both have an entry in the *same* `~/.claude/settings.json` at once: every
/// `claude` session then POSTs to both endpoints, and each server keeps only the
/// sessions it minted (the others are dropped by the session-id filter). The two
/// paths are matched with `ends_with` (see [`is_ours`]), not `contains`, precisely
/// because the debug path has the release path as a prefix.
pub const HOOK_PATH: &str = if cfg!(debug_assertions) {
    "/__workbench_hook__dev"
} else {
    "/__workbench_hook"
};

/// The hook events Workbench subscribes to (design §4.4). All are valid Claude Code
/// event names. A single matcher-less entry per event fires for every matcher, so
/// the server receives e.g. all `Notification` types and inspects the payload.
const HOOK_EVENTS: &[&str] = &[
    "UserPromptSubmit",
    "PreToolUse",
    "PostToolUse",
    "PermissionRequest",
    "PermissionDenied",
    "Notification",
    "Stop",
    "SubagentStart",
    "SubagentStop",
    "SessionStart",
    "SessionEnd",
    "PreCompact",
];

/// Install (or refresh) the Workbench hooks pointing at `port`. Returns `Ok(true)`
/// if the file was written, `Ok(false)` if it was already up to date (the common
/// case on relaunch — proving the install is idempotent).
pub fn install_hooks(port: u16) -> Result<bool, String> {
    let path = settings_path()?;
    let url = format!("http://127.0.0.1:{port}{HOOK_PATH}");
    install_hooks_at(&path, &url)
}

/// Core install, parameterised on path + URL so it's testable without touching a
/// real `~/.claude`.
fn install_hooks_at(path: &Path, url: &str) -> Result<bool, String> {
    let original = read_settings(path)?;
    let mut settings = original.clone();
    apply_hooks(&mut settings, url)?;
    if settings == original {
        return Ok(false);
    }
    write_settings(path, &settings)?;
    Ok(true)
}

/// Read `settings.json` as a JSON object, returning `{}` if the file is absent.
/// A parse failure or a non-object root is a hard error: we refuse to clobber a
/// file we don't understand.
fn read_settings(path: &Path) -> Result<Value, String> {
    match std::fs::read_to_string(path) {
        Ok(text) if text.trim().is_empty() => Ok(json!({})),
        Ok(text) => {
            let value: Value = serde_json::from_str(&text)
                .map_err(|e| format!("{} is not valid JSON: {e}", path.display()))?;
            if value.is_object() {
                Ok(value)
            } else {
                Err(format!("{} is not a JSON object", path.display()))
            }
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(json!({})),
        Err(e) => Err(format!("reading {}: {e}", path.display())),
    }
}

/// Mutate `settings` so that, for each subscribed event, exactly one Workbench hook
/// entry pointing at `url` is present, with foreign entries preserved.
fn apply_hooks(settings: &mut Value, url: &str) -> Result<(), String> {
    let root = settings
        .as_object_mut()
        .ok_or("settings root is not an object")?;

    // Ensure `hooks` is an object we can extend.
    let hooks = root.entry("hooks").or_insert_with(|| json!({}));
    let hooks = hooks
        .as_object_mut()
        .ok_or("`hooks` is present but is not an object")?;

    for &event in HOOK_EVENTS {
        let entries = take_event_array(hooks, event)?;
        let mut next: Vec<Value> = Vec::with_capacity(entries.len() + 1);

        // Drop our own previous entries (so a re-run / port change doesn't pile up);
        // keep every foreign entry verbatim.
        for entry in entries {
            match entry.get("hooks").and_then(Value::as_array) {
                Some(inner) => {
                    let before = inner.len();
                    let kept: Vec<Value> =
                        inner.iter().filter(|h| !is_ours(h)).cloned().collect();
                    // An entry we emptied was purely ours — drop it. An entry that
                    // was already empty (foreign oddity) is left as-is.
                    if kept.is_empty() && kept.len() < before {
                        continue;
                    }
                    let mut entry = entry;
                    entry["hooks"] = Value::Array(kept);
                    next.push(entry);
                }
                None => next.push(entry), // foreign entry without a hooks array
            }
        }

        // Append our fresh entry: matcher-less (fires for all matchers), one http
        // hook to our endpoint.
        next.push(json!({
            "hooks": [ { "type": "http", "url": url } ]
        }));

        hooks.insert(event.to_string(), Value::Array(next));
    }

    Ok(())
}

/// Remove `hooks[event]` and return it as a vec of entries. A missing key yields an
/// empty vec; a present-but-not-array value is an error (don't silently discard).
fn take_event_array(hooks: &mut Map<String, Value>, event: &str) -> Result<Vec<Value>, String> {
    match hooks.remove(event) {
        None => Ok(Vec::new()),
        Some(Value::Array(a)) => Ok(a),
        Some(_) => Err(format!("hooks.{event} is present but is not an array")),
    }
}

/// True when a hook object is one of ours: an `http` hook whose URL ends with this
/// build's sentinel path. Matching the path (not the full URL) makes us
/// port-agnostic; matching with `ends_with` rather than `contains` keeps the
/// release build (`…/__workbench_hook`) from claiming the debug build's entry
/// (`…/__workbench_hook__dev`), which has the release path as a prefix.
fn is_ours(hook: &Value) -> bool {
    hook.get("type").and_then(Value::as_str) == Some("http")
        && hook
            .get("url")
            .and_then(Value::as_str)
            .is_some_and(|u| u.ends_with(HOOK_PATH))
}

/// Write `settings` pretty-printed, creating `~/.claude` if needed. Writes to a
/// temp file then renames over the target (atomic replace on Windows and Unix) so a
/// crash mid-write can't truncate the user's config.
fn write_settings(path: &Path, settings: &Value) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("creating {}: {e}", dir.display()))?;
    }
    let text = serde_json::to_string_pretty(settings).map_err(|e| e.to_string())?;
    let tmp = path.with_extension("json.wbtmp");
    std::fs::write(&tmp, text).map_err(|e| format!("writing {}: {e}", tmp.display()))?;
    std::fs::rename(&tmp, path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("replacing {}: {e}", path.display())
    })
}

/// `~/.claude/settings.json`.
fn settings_path() -> Result<PathBuf, String> {
    let home = std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .ok_or("no home directory (USERPROFILE/HOME unset)")?;
    Ok(PathBuf::from(home).join(".claude").join("settings.json"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_settings(tag: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("wb-hooks-{tag}-{nanos}"));
        std::fs::create_dir_all(&dir).unwrap();
        dir.join("settings.json")
    }

    fn read(path: &Path) -> Value {
        serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
    }

    /// Count Workbench http entries across all events.
    fn ours_count(settings: &Value) -> usize {
        let mut n = 0;
        if let Some(hooks) = settings["hooks"].as_object() {
            for entries in hooks.values() {
                for entry in entries.as_array().into_iter().flatten() {
                    for hook in entry["hooks"].as_array().into_iter().flatten() {
                        if is_ours(hook) {
                            n += 1;
                        }
                    }
                }
            }
        }
        n
    }

    #[test]
    fn installs_one_entry_per_event_into_a_missing_file() {
        let path = temp_settings("fresh");
        let url = format!("http://127.0.0.1:48970{HOOK_PATH}");

        let wrote = install_hooks_at(&path, &url).unwrap();
        assert!(wrote, "a fresh install should write the file");

        let settings = read(&path);
        assert_eq!(ours_count(&settings), HOOK_EVENTS.len());
        // Each subscribed event got exactly one entry.
        for &event in HOOK_EVENTS {
            let entries = settings["hooks"][event].as_array().unwrap();
            assert_eq!(entries.len(), 1, "{event} should have one entry");
        }

        std::fs::remove_dir_all(path.parent().unwrap()).ok();
    }

    #[test]
    fn reinstall_is_idempotent() {
        let path = temp_settings("idem");
        let url = format!("http://127.0.0.1:48970{HOOK_PATH}");

        assert!(install_hooks_at(&path, &url).unwrap());
        // Second run with the same URL changes nothing → no write, no duplicates.
        assert!(!install_hooks_at(&path, &url).unwrap());
        assert_eq!(ours_count(&read(&path)), HOOK_EVENTS.len());

        std::fs::remove_dir_all(path.parent().unwrap()).ok();
    }

    #[test]
    fn port_change_replaces_rather_than_duplicates() {
        let path = temp_settings("port");
        let old = format!("http://127.0.0.1:48970{HOOK_PATH}");
        let new = format!("http://127.0.0.1:49001{HOOK_PATH}");

        install_hooks_at(&path, &old).unwrap();
        let wrote = install_hooks_at(&path, &new).unwrap();
        assert!(wrote, "a new port should rewrite the file");

        let settings = read(&path);
        assert_eq!(
            ours_count(&settings),
            HOOK_EVENTS.len(),
            "still one entry per event, not two"
        );
        // And every entry now points at the new port.
        let entry = &settings["hooks"]["Stop"][0]["hooks"][0]["url"];
        assert_eq!(entry.as_str().unwrap(), new);

        std::fs::remove_dir_all(path.parent().unwrap()).ok();
    }

    #[test]
    fn foreign_hooks_are_preserved() {
        let path = temp_settings("foreign");
        // A user's pre-existing command hook on PreToolUse, plus an unrelated key.
        let preexisting = json!({
            "model": "opus",
            "hooks": {
                "PreToolUse": [
                    { "matcher": "Bash", "hooks": [ { "type": "command", "command": "echo hi" } ] }
                ]
            }
        });
        std::fs::write(&path, serde_json::to_string_pretty(&preexisting).unwrap()).unwrap();

        let url = format!("http://127.0.0.1:48970{HOOK_PATH}");
        install_hooks_at(&path, &url).unwrap();

        let settings = read(&path);
        // The unrelated key survived.
        assert_eq!(settings["model"], json!("opus"));
        // PreToolUse now has the foreign entry AND ours.
        let entries = settings["hooks"]["PreToolUse"].as_array().unwrap();
        assert_eq!(entries.len(), 2);
        let foreign = entries
            .iter()
            .any(|e| e["hooks"][0]["command"] == json!("echo hi"));
        assert!(foreign, "the user's command hook must be preserved");

        // A re-run still doesn't disturb the foreign hook or duplicate ours.
        assert!(!install_hooks_at(&path, &url).unwrap());
        let entries = read(&path)["hooks"]["PreToolUse"].as_array().unwrap().len();
        assert_eq!(entries, 2);

        std::fs::remove_dir_all(path.parent().unwrap()).ok();
    }

    #[test]
    fn other_builds_workbench_entry_is_left_alone() {
        // The "other" build's sentinel: whichever this test build is NOT. Tests
        // compile in debug, so HOOK_PATH is the dev path; the release path
        // (`/__workbench_hook`) is the other build's, and must survive our install
        // so a release + dev instance can coexist in one settings.json.
        let other_path = if HOOK_PATH.ends_with("__dev") {
            "/__workbench_hook"
        } else {
            "/__workbench_hook__dev"
        };
        let other_url = format!("http://127.0.0.1:40000{other_path}");

        let path = temp_settings("coexist");
        let preexisting = json!({
            "hooks": { "Stop": [ { "hooks": [ { "type": "http", "url": other_url } ] } ] }
        });
        std::fs::write(&path, serde_json::to_string_pretty(&preexisting).unwrap()).unwrap();

        let url = format!("http://127.0.0.1:48970{HOOK_PATH}");
        install_hooks_at(&path, &url).unwrap();

        // Stop now has BOTH the other build's entry and ours.
        let settings = read(&path);
        let urls: Vec<String> = settings["hooks"]["Stop"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|e| e["hooks"][0]["url"].as_str().map(str::to_owned))
            .collect();
        assert!(urls.contains(&other_url), "other build's hook must be preserved");
        assert!(urls.contains(&url), "our hook must be added");

        std::fs::remove_dir_all(path.parent().unwrap()).ok();
    }

    #[test]
    fn unparseable_settings_is_an_error_not_a_clobber() {
        let path = temp_settings("corrupt");
        std::fs::write(&path, "{ not json").unwrap();
        let url = format!("http://127.0.0.1:48970{HOOK_PATH}");

        assert!(install_hooks_at(&path, &url).is_err());
        // The original bytes are untouched.
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "{ not json");

        std::fs::remove_dir_all(path.parent().unwrap()).ok();
    }
}
