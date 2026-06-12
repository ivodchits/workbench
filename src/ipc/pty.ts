// Typed wrappers over the Rust PTY commands. The backend owns each child; we
// stream its output in over a Tauri Channel and send keystrokes + resize back via
// commands. Step 1.5 keys every call by `instanceId` so many consoles run at
// once, and exposes the `session_id → instance_id` lookup the Phase-2 hook server
// will use.

import { Channel, invoke } from "@tauri-apps/api/core";

// Tauri serializes the Rust `Vec<u8>` as a JS number array over the IPC channel.
export type PtyChunk = number[];

/** What the PTY runs: the interactive `claude` TUI, or a plain shell. */
export type SpawnKind = "claude" | "shell";

/** Returned at spawn. `sessionId` is the minted `--session-id` for `claude`. */
export interface SpawnResult {
  sessionId: string | null;
  cwd: string;
}

// The backend struct uses snake_case; map it to camelCase at the boundary.
interface RawSpawnResult {
  session_id: string | null;
  cwd: string;
}

/**
 * Spawn the chosen child for `instanceId` in `cwd`, routing output to `onOutput`.
 * `resumeSessionId` (claude only, step 3.8): when set, launch `claude --resume
 * <id>` to continue that session instead of minting a fresh one; null = fresh.
 */
export async function ptySpawn(
  instanceId: string,
  onOutput: Channel<PtyChunk>,
  kind: SpawnKind,
  cwd: string | null,
  resumeSessionId: string | null,
  cols: number,
  rows: number,
): Promise<SpawnResult> {
  const raw = await invoke<RawSpawnResult>("pty_spawn", {
    instanceId,
    onOutput,
    kind,
    cwd,
    resumeSessionId,
    cols,
    rows,
  });
  return { sessionId: raw.session_id, cwd: raw.cwd };
}

/** Forward keystrokes (UTF-8 bytes) to an instance's PTY. */
export function ptyWrite(instanceId: string, data: Uint8Array): Promise<void> {
  return invoke("pty_write", { instanceId, data: Array.from(data) });
}

/** Resize an instance's PTY to match its terminal's cols/rows. */
export function ptyResize(instanceId: string, cols: number, rows: number): Promise<void> {
  return invoke("pty_resize", { instanceId, cols, rows });
}

/** Kill an instance's PTY child. */
export function ptyKill(instanceId: string): Promise<void> {
  return invoke("pty_kill", { instanceId });
}

/** Resolve a `session_id` to its owning `instanceId` (Phase-2 hook routing). */
export function sessionInstance(sessionId: string): Promise<string | null> {
  return invoke("session_instance", { sessionId });
}

/** Whether `instanceId` has a live (non-exited) child process — the truthful
 *  "is something already running here?" check for the resume shortcut (step 3.8),
 *  which the console store can't answer once a session self-exits. */
export function ptySessionLive(instanceId: string): Promise<boolean> {
  return invoke("pty_session_live", { instanceId });
}

/** The home dir, used to prefill the launcher's working-dir field. */
export function defaultWorkingDir(): Promise<string | null> {
  return invoke("default_working_dir");
}
