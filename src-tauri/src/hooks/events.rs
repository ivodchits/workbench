//! Typed hook payloads (step 2.1).
//!
//! The shapes Claude Code POSTs to an `http` hook. Every event carries a common
//! envelope (`session_id`, `hook_event_name`, `cwd`, `transcript_path`,
//! `permission_mode`); the event-specific fields (tool name/input, notification
//! type, subagent ids, …) vary by event, so we keep a couple of common ones typed
//! and capture the remainder in `rest` rather than modelling all ~30 events now.
//! The Phase-2 status state machine (step 2.2) consumes these — here we only parse,
//! filter by `session_id`, and forward.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

/// A single hook event as received from Claude Code. Field names mirror the hook
/// payload exactly (snake_case), so this type doubles as documentation of the wire
/// format. Unknown/event-specific fields land in `rest` via `#[serde(flatten)]`,
/// so nothing is dropped on the way to the frontend.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct HookEvent {
    /// The minted UUID we passed as `--session-id`. The hook server filters on this.
    pub session_id: String,
    /// e.g. `PreToolUse`, `PermissionRequest`, `Stop`. Absent on malformed input.
    #[serde(default)]
    pub hook_event_name: Option<String>,
    /// Path to the session transcript JSONL (used by the Phase-3 token/cost tailer).
    #[serde(default)]
    pub transcript_path: Option<String>,
    /// The session's current working directory.
    #[serde(default)]
    pub cwd: Option<String>,
    /// `default` / `plan` / `acceptEdits` / … — the active permission mode.
    #[serde(default)]
    pub permission_mode: Option<String>,
    /// Tool name on `PreToolUse` / `PostToolUse` / `PermissionRequest` events.
    #[serde(default)]
    pub tool_name: Option<String>,
    /// Everything else (tool input/response, notification type, subagent ids, …),
    /// preserved verbatim for the status machine.
    #[serde(flatten)]
    pub rest: Map<String, Value>,
}

/// What the hook server emits to the frontend (`hook-event`) once an event has
/// passed the session-id filter: the resolved `instance_id` plus the raw event.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HookEnvelope {
    /// The card this event belongs to (resolved from `session_id`).
    pub instance_id: String,
    /// Receipt time (epoch seconds), so the rail can show last-activity.
    pub received_at: i64,
    /// The parsed event.
    pub event: HookEvent,
}
