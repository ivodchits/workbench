// Typed wrappers over the remote-host commands (step 3.12). These are the
// out-of-band `ssh` calls that don't flow through a PTY: list the tmux sessions on
// a host (to reconcile our `wb-*` instances and offer adopting foreign sessions)
// and kill a session (when a remote instance is removed — detach ≠ kill).

import { invoke } from "@tauri-apps/api/core";

/** List the tmux session names on `dest` (`tmux ls`). Resolves to an empty list
 *  when no tmux server is running there yet; rejects on a real ssh failure. */
export function remoteTmuxSessions(dest: string): Promise<string[]> {
  return invoke("remote_tmux_sessions", { dest });
}

/** Kill a tmux session on `dest`. Idempotent — a missing session resolves OK. */
export function remoteKillSession(dest: string, session: string): Promise<void> {
  return invoke("remote_kill_session", { dest, session });
}
