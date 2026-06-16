// OS-window tear-off orchestration (step 4.2) — pop a Console or Project Shell
// panel out into its own Tauri window on another monitor, keeping it live.
//
// This rides entirely on the step-4.1 PTY multiplexer: a PTY is owned by the Rust
// core and keyed by id (instance id / shell id), independent of any window. A
// torn-off window is just a *second webview* that loads the same bundle in
// "torn" mode (see `torn/TornWindow`) and attaches to that PTY as another
// `pty_subscribe` subscriber — scrollback replays, input routes back, and the
// min-size arbitration handles two clients (design §5, §11, decision 13).
//
// The flow:
//   tear off → flag the panel `tornOff`, release the *main* dock's terminal
//              WITHOUT killing the PTY (keepPty), open the torn-off window.
//   dock back (the user closes the window) → clear `tornOff`; the Workspace
//              reconciler re-adds the panel, which re-`acquire`s in attach mode
//              and re-subscribes to the still-live PTY.
//
// Restart is deliberately simple: `tornOff` is runtime-only (not persisted), and
// the Workspace persists a torn-off panel's id as an ordinary console/shell, so on
// relaunch it returns to the main dock as a dormant placeholder — matching
// Workbench's "restore dormant, don't auto-launch" philosophy.

import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { TauriEvent } from "@tauri-apps/api/event";

import { registerConsoleTornCloser, setConsoleTornOff } from "./consoles";
import { registerShellTornCloser, setShellTornOff } from "./shells";
import { release } from "../panels/terminalPool";

export type TornKind = "console" | "shell";

/** Live torn-off windows, keyed `kind:id`, so a repeat tear-off focuses the
 *  existing window and the rail-kill path can close it. */
const windows = new Map<string, WebviewWindow>();

function keyFor(kind: TornKind, id: string): string {
  return `${kind}:${id}`;
}

/** A Tauri window label allows `[a-zA-Z0-9-/:_]`; shell ids contain `:`, so fold
 *  anything outside that set to `_` for a safe, stable label. */
function labelFor(kind: TornKind, id: string): string {
  return `torn-${kind}-${id.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
}

/** Strip the `console · ` / `shell · ` panel prefix for the OS window title. */
function windowTitle(title: string): string {
  const dot = title.indexOf(" · ");
  return dot >= 0 ? title.slice(dot + 3) : title;
}

/**
 * Tear a console/shell panel off into its own OS window. Idempotent per id: a
 * second call just focuses the existing window.
 */
export function tearOff(kind: TornKind, id: string, title: string): void {
  const key = keyFor(kind, id);
  const existing = windows.get(key);
  if (existing) {
    void existing.setFocus();
    return;
  }

  // Flag it (drops the main-dock panel via the reconciler) and release the dock's
  // terminal *without* killing the child — the new window becomes its subscriber.
  if (kind === "console") setConsoleTornOff(id, true);
  else setShellTornOff(id, true);
  release(id, { keepPty: true });

  const label = labelFor(kind, id);
  const params = new URLSearchParams({ torn: kind, id, title: windowTitle(title) });
  const win = new WebviewWindow(label, {
    url: `index.html?${params.toString()}`,
    title: `${windowTitle(title)} — Workbench`,
    width: 900,
    height: 640,
    minWidth: 480,
    minHeight: 320,
  });
  windows.set(key, win);

  // Closing the OS window docks the panel back into the main dock (keeping the
  // session alive). A creation error (e.g. a stale label) also unwinds the flag.
  void win.once(TauriEvent.WINDOW_DESTROYED, () => dockBack(kind, id));
  void win.once("tauri://error", (e) => {
    console.error("workbench: tear-off window failed", e);
    dockBack(kind, id);
  });
}

/** Dock a torn-off panel back into the main dock (its window closed). The
 *  reconciler re-adds the panel, which re-attaches to the still-live PTY. */
export function dockBack(kind: TornKind, id: string): void {
  windows.delete(keyFor(kind, id));
  if (kind === "console") setConsoleTornOff(id, false);
  else setShellTornOff(id, false);
}

/** Close a torn-off window programmatically — used when its console/shell is killed
 *  from the rail (the panel isn't in the main dock to drive the close). No-op if no
 *  window is open for the id. */
export function closeTornWindow(kind: TornKind, id: string): void {
  const key = keyFor(kind, id);
  const win = windows.get(key);
  if (!win) return;
  windows.delete(key);
  void win.close();
}

/**
 * Wire the store→window closers (main window only, once at startup). Without this a
 * torn-off console/shell killed from the rail would leave its OS window orphaned.
 */
export function initTearOff(): void {
  registerConsoleTornCloser((id) => closeTornWindow("console", id));
  registerShellTornCloser((id) => closeTornWindow("shell", id));
}
