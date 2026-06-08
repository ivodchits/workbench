// Typed wrappers over the Rust PTY commands (steps 0.2–0.3). The backend owns
// the child; we stream its output in over a Tauri Channel and send keystrokes +
// resize back via commands. Step 0.3 adds the `claude` launcher: pick a working
// dir and kind, and the backend returns the session UUID it minted.

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

/** Spawn the chosen child in `cwd` and route its output to `onOutput`. */
export async function ptySpawn(
  onOutput: Channel<PtyChunk>,
  kind: SpawnKind,
  cwd: string | null,
  cols: number,
  rows: number,
): Promise<SpawnResult> {
  const raw = await invoke<RawSpawnResult>("pty_spawn", { onOutput, kind, cwd, cols, rows });
  return { sessionId: raw.session_id, cwd: raw.cwd };
}

/** Forward keystrokes (UTF-8 bytes) to the PTY. */
export function ptyWrite(data: Uint8Array): Promise<void> {
  return invoke("pty_write", { data: Array.from(data) });
}

/** Resize the PTY to match the terminal's cols/rows. */
export function ptyResize(cols: number, rows: number): Promise<void> {
  return invoke("pty_resize", { cols, rows });
}

/** Kill the active PTY child. */
export function ptyKill(): Promise<void> {
  return invoke("pty_kill");
}

/** The home dir, used to prefill the launcher's working-dir field. */
export function defaultWorkingDir(): Promise<string | null> {
  return invoke("default_working_dir");
}
