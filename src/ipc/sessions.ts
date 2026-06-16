// Typed access to Claude session enumeration (resume picker, step 4.x). The Rust
// backend scans `~/.claude/projects/<encoded-cwd>/*.jsonl` and returns every session
// whose recorded working dir matches — the original plus its `/clear` rotation
// children — so the picker can offer them for `claude --resume`.

import { invoke } from "@tauri-apps/api/core";

/** One resumable session, as summarized from its transcript JSONL. */
export interface SessionSummary {
  /** The session UUID passed to `claude --resume`. */
  sessionId: string;
  /** File mtime (epoch seconds) — "last active", newest first from the backend. */
  modifiedAt: number;
  /** First human prompt, cleaned + truncated; empty when none could be read. */
  firstPrompt: string;
  /** The session's working directory (as recorded in the transcript). */
  cwd: string;
}

/** List every Claude session whose working dir is `workingDir`, newest first. */
export function listProjectSessions(workingDir: string): Promise<SessionSummary[]> {
  return invoke("list_project_sessions", { workingDir });
}
