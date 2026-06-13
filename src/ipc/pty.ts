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

/**
 * Remote launch descriptor (step 3.12). When passed to `ptySpawn`, the child is a
 * local `ssh` process that attaches-or-creates a tmux session on `dest` and runs
 * `claude` inside it — so the TUI streams over SSH while the session persists
 * across console close / app quit. Null for a normal local launch.
 */
export interface RemoteSpawn {
  /** SSH destination — a `~/.ssh/config` alias or `user@host`. */
  dest: string;
  /** tmux session name on the host (`wb-<short id>`, or an adopted name). */
  session: string;
  /** Working directory on the host the session starts in. */
  dir: string;
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
 * `remote` (step 3.12): when set, drive a remote `claude` over SSH+tmux instead of
 * a local child (and no session id is minted — the result's `sessionId` is null).
 */
export async function ptySpawn(
  instanceId: string,
  onOutput: Channel<PtyChunk>,
  kind: SpawnKind,
  cwd: string | null,
  resumeSessionId: string | null,
  remote: RemoteSpawn | null,
  cols: number,
  rows: number,
): Promise<SpawnResult> {
  const raw = await invoke<RawSpawnResult>("pty_spawn", {
    instanceId,
    onOutput,
    kind,
    cwd,
    resumeSessionId,
    remote,
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

/** Payload of the `remote-cmd-done` event — emitted when a `remoteCmdSpawn` child
 *  exits, carrying everything it printed (step 3.12). */
export interface RemoteCmdDone {
  id: string;
  output: string;
}

/**
 * Run an interactive one-shot remote command in a PTY: `ssh -tt <dest> -- <command>`
 * (step 3.12). The child streams to `onOutput` (mount it in an xterm so the user can
 * type their SSH password); drive keystrokes/resize/kill with the normal
 * `ptyWrite`/`ptyResize`/`ptyKill` using the same `id`. When it exits, the backend
 * emits a `remote-cmd-done` event with the captured output. `command` is sent as one
 * token after `--`, so pre-quote it for the remote shell (e.g. `bash -lc 'tmux ls'`).
 */
export function remoteCmdSpawn(
  id: string,
  dest: string,
  command: string,
  onOutput: Channel<PtyChunk>,
  cols: number,
  rows: number,
): Promise<void> {
  return invoke("remote_cmd_spawn", { id, dest, command, onOutput, cols, rows });
}
