//! Refusing a shell command that only opens a media file in another app (S2): the
//! `PreToolUse` hook is answered with a denial that says to use `show_media`.
//!
//! Only a command that does nothing else is refused: `start out.png`,
//! `Invoke-Item .\clip.mp4`, `ii a.wav`, `explorer chart.svg`, `open x.gif`,
//! `xdg-open y.webm`, `cmd /c start "" z.png`. A command that builds the file and
//! then opens it (`python plot.py && start out.png`) is left alone: refusing it would
//! throw the work away.

use serde_json::{json, Value};

use super::{classify, Kind};

/// The reason the agent reads.
pub const REASON: &str = "Don't open media files in other apps here: their windows pile up. Call the show_media tool with the file's path instead; it shows the file in this session.";

/// The shells whose commands are looked at.
const SHELL_TOOLS: [&str; 2] = ["Bash", "PowerShell"];

/// Commands that open a file in its default app.
const OPENERS: [&str; 6] = ["start", "invoke-item", "ii", "explorer", "explorer.exe", "open"];

/// Whether `command` does nothing but open one or more media files.
pub fn only_opens_media(command: &str) -> bool {
    let mut words = split(command.trim());
    if words.is_empty() {
        return false;
    }
    // `cmd /c start …`, `cmd.exe /c start …`
    if matches!(words[0].to_ascii_lowercase().as_str(), "cmd" | "cmd.exe")
        && words.get(1).is_some_and(|w| w.eq_ignore_ascii_case("/c"))
    {
        words.drain(..2);
    }
    let Some(first) = words.first() else {
        return false;
    };
    let opener = first.to_ascii_lowercase();
    if !OPENERS.contains(&opener.as_str()) && opener != "xdg-open" {
        return false;
    }
    let mut files = 0;
    for w in &words[1..] {
        // `start ""` (the window title), and PowerShell's `-Path`.
        if w.is_empty() || w.eq_ignore_ascii_case("-path") || w.eq_ignore_ascii_case("-literalpath") {
            continue;
        }
        // Anything that isn't a media file (a pipe, a second command, a URL) means
        // it isn't only opening one.
        if w.contains("://") || classify(std::path::Path::new(w)).0 == Kind::File {
            return false;
        }
        files += 1;
    }
    files > 0
}

/// Split a command into words, keeping quoted ones whole (quotes removed). A
/// separator (`&&`, `;`, `|`, `>`) is its own word, so it never looks like a file.
fn split(command: &str) -> Vec<String> {
    let mut words = Vec::new();
    let mut word = String::new();
    let mut quote: Option<char> = None;
    let mut quoted = false;
    for c in command.chars() {
        match quote {
            Some(q) if c == q => quote = None,
            Some(_) => word.push(c),
            None if c == '"' || c == '\'' => {
                quote = Some(c);
                quoted = true;
            }
            None if c.is_whitespace() => {
                if !word.is_empty() || quoted {
                    words.push(std::mem::take(&mut word));
                }
                quoted = false;
            }
            None if matches!(c, '&' | ';' | '|' | '>' | '<' | '\n') => {
                if !word.is_empty() || quoted {
                    words.push(std::mem::take(&mut word));
                }
                quoted = false;
                words.push(c.to_string());
            }
            None => word.push(c),
        }
    }
    if !word.is_empty() || quoted {
        words.push(word);
    }
    words
}

/// The hook answer for a `PreToolUse` event, when it's a shell command that only
/// opens media: a denial with [`REASON`].
pub fn answer(tool_name: Option<&str>, rest: &serde_json::Map<String, Value>) -> Option<Value> {
    if !SHELL_TOOLS.contains(&tool_name?) {
        return None;
    }
    let command = rest.get("tool_input")?.get("command")?.as_str()?;
    only_opens_media(command).then(|| {
        json!({
            "hookSpecificOutput": {
                "hookEventName": "PreToolUse",
                "permissionDecision": "deny",
                "permissionDecisionReason": REASON
            }
        })
    })
}
