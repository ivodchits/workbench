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
 * Spawn the chosen child for `instanceId` in `cwd`. Output is **not** wired here:
 * since step 4.1 the PTY fans out to N subscribers, so attach one with
 * `ptySubscribe` after this resolves. `resumeSessionId` (claude only, step 3.8):
 * when set, launch `claude --resume <id>` to continue that session instead of
 * minting a fresh one; null = fresh. `remote` (step 3.12): when set, drive a remote
 * `claude` over SSH+tmux instead of a local child (and no session id is minted —
 * the result's `sessionId` is null).
 */
export async function ptySpawn(
  instanceId: string,
  kind: SpawnKind,
  cwd: string | null,
  resumeSessionId: string | null,
  remote: RemoteSpawn | null,
  cols: number,
  rows: number,
): Promise<SpawnResult> {
  const raw = await invoke<RawSpawnResult>("pty_spawn", {
    instanceId,
    kind,
    cwd,
    resumeSessionId,
    remote,
    cols,
    rows,
  });
  return { sessionId: raw.session_id, cwd: raw.cwd };
}

/**
 * Attach an output subscriber to a live PTY (step 4.1) and return its subscription
 * id. The PTY's recent scrollback is replayed into `onOutput` immediately, then
 * live output streams in alongside any other subscribers. Pass the returned id to
 * `ptyUnsubscribe` on close and to `ptyResize` so this terminal's size joins the
 * min-size arbitration.
 */
export function ptySubscribe(
  instanceId: string,
  onOutput: Channel<PtyChunk>,
): Promise<number> {
  return invoke("pty_subscribe", { instanceId, onOutput });
}

/** Detach a subscriber (`subId` from `ptySubscribe`) without killing the PTY — the
 *  console closed but the session keeps running (step 4.1). */
export function ptyUnsubscribe(instanceId: string, subId: number): Promise<void> {
  return invoke("pty_unsubscribe", { instanceId, subId });
}

/** Forward keystrokes (UTF-8 bytes) to an instance's PTY. */
export function ptyWrite(instanceId: string, data: Uint8Array): Promise<void> {
  return invoke("pty_write", { instanceId, data: Array.from(data) });
}

/** The keystroke that interrupts a running agent: ESC stops the current generation in
 *  the claude TUI. The **single source** for this key (design §11 caveat — keep the
 *  approve/deny/interrupt mapping in one place so a TUI change is a one-line fix); the
 *  rail interrupt action and the remote-action handler both send it. */
export const INTERRUPT_KEY = new Uint8Array([0x1b]);

/** Carriage return — submits the current TUI line (approve a permission prompt, send
 *  a typed prompt). The other half of the §11 keystroke mapping. */
export const ENTER_KEY = new Uint8Array([0x0d]);

/**
 * Resize an instance's PTY to match its terminal's cols/rows. `subId` (step 4.1):
 * a console passes its subscription id so its size joins the PTY's min-size
 * arbitration across subscribers; omit it (the remote-command modal) to resize the
 * PTY directly.
 */
export function ptyResize(
  instanceId: string,
  cols: number,
  rows: number,
  subId?: number,
): Promise<void> {
  return invoke("pty_resize", { instanceId, subId: subId ?? null, cols, rows });
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
