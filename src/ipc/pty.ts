// Typed wrappers over the Rust PTY commands (step 0.2). The backend owns the
// shell child; we stream its output in over a Tauri Channel and send keystrokes
// + resize back via commands.

import { Channel, invoke } from "@tauri-apps/api/core";

// Tauri serializes the Rust `Vec<u8>` as a JS number array over the IPC channel.
export type PtyChunk = number[];

/** Spawn the shell PTY and route its output to `onOutput`. */
export function ptySpawn(onOutput: Channel<PtyChunk>, cols: number, rows: number): Promise<void> {
  return invoke("pty_spawn", { onOutput, cols, rows });
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
