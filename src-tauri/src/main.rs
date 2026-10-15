// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

/// Per-session markers a running Claude Code sets in its children's environment.
/// If the app is launched from inside a Claude session (e.g. a build/install step
/// run from its shell), every `claude` we spawn would inherit them, treat itself as
/// a nested child session, and turn transcript saving off — so drop them up front.
/// User-level config (`CLAUDE_CODE_USE_BEDROCK`, …) is deliberately left alone.
const INHERITED_CLAUDE_SESSION_VARS: &[&str] = &[
    "CLAUDECODE",
    "CLAUDE_PID",
    "CLAUDE_CODE_CHILD_SESSION",
    "CLAUDE_CODE_ENTRYPOINT",
    "CLAUDE_CODE_SESSION_ID",
    "CLAUDE_CODE_SESSION_ATTENDED",
    "CLAUDE_CODE_MESSAGING_SOCKET",
    "CLAUDE_CODE_MESSAGING_TOKEN",
];

fn main() {
    // Still single-threaded here, so mutating the process env is sound.
    for var in INHERITED_CLAUDE_SESSION_VARS {
        std::env::remove_var(var);
    }
    workbench_lib::run()
}
