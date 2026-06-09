// Terminal pool (step 1.6 follow-up) — keeps each instance's `xterm` terminal and
// its backing PTY alive independently of React's component tree.
//
// Why: dockview's drag-and-drop only works with its default `onlyWhenVisible`
// renderer, which *unmounts* a panel's content when it's tabbed away or moved
// between groups. If the terminal lived in the React component, that unmount
// would tear down the PTY (killing the `claude` session) and lose scrollback. So
// the Terminal is created once into a detached `host` element owned here; the
// Console component merely parents that host into its container while mounted and
// detaches it on unmount. The PTY streams into the same Terminal the whole time,
// so switching tabs / dragging panels preserves the live session and scrollback.
//
// Lifetime is explicit: `acquire` creates-or-returns an entry (spawning the PTY
// on first creation); `release` is the only thing that kills the PTY and disposes
// the terminal, and is called when a console is genuinely closed (see Workspace).

import { Channel } from "@tauri-apps/api/core";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import "@xterm/xterm/css/xterm.css";

import { deriveXtermTheme, mono } from "../theme/tokens";
import {
  ptyKill,
  ptyResize,
  ptySpawn,
  ptyWrite,
  type PtyChunk,
  type SpawnKind,
  type SpawnResult,
} from "../ipc/pty";

interface TermEntry {
  /** The element xterm renders into; re-parented across mounts, never recreated. */
  host: HTMLDivElement;
  term: Terminal;
  fit: FitAddon;
  dataSub: { dispose(): void };
  resizeSub: { dispose(): void };
}

export interface AcquireOptions {
  instanceId: string;
  kind: SpawnKind;
  cwd: string;
  webgl: boolean;
  /** Called once, when the PTY spawn for a freshly created entry resolves. */
  onSpawned: (result: SpawnResult) => void;
  /** Called once, if that spawn fails (the entry is released). */
  onError: (message: string) => void;
}

const pool = new Map<string, TermEntry>();

/**
 * Attach the instance's terminal into `container`, creating the terminal + PTY on
 * first call. Safe to call on every mount: an existing entry is just re-parented
 * and refit. Returns nothing — the caller drives detach via `detach`/`release`.
 */
export function acquire(container: HTMLDivElement, opts: AcquireOptions): void {
  const existing = pool.get(opts.instanceId);
  if (existing) {
    container.appendChild(existing.host); // moves it out of any old container
    refit(existing);
    existing.term.focus();
    return;
  }

  const host = document.createElement("div");
  host.style.height = "100%";
  host.style.width = "100%";
  container.appendChild(host);

  const term = new Terminal({
    fontFamily: mono,
    fontSize: 13,
    cursorBlink: true,
    theme: deriveXtermTheme(),
    allowProposedApi: true,
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.open(host);

  // WebGL must load after open (it needs the rendered canvas). Dispose on context
  // loss so xterm reverts to the DOM renderer rather than rendering nothing.
  if (opts.webgl) {
    try {
      const addon = new WebglAddon();
      addon.onContextLoss(() => addon.dispose());
      term.loadAddon(addon);
    } catch {
      // WebGL unavailable; xterm keeps its DOM renderer.
    }
  }

  const output = new Channel<PtyChunk>();
  output.onmessage = (chunk) => term.write(new Uint8Array(chunk));

  const dataSub = term.onData((data) => {
    void ptyWrite(opts.instanceId, new TextEncoder().encode(data));
  });
  const resizeSub = term.onResize(({ cols, rows }) => {
    void ptyResize(opts.instanceId, cols, rows);
  });

  const entry: TermEntry = { host, term, fit, dataSub, resizeSub };
  pool.set(opts.instanceId, entry);

  // Defer the first fit + spawn one frame so xterm has rendered and the addon can
  // measure char size; then spawn the child at the fitted dimensions.
  requestAnimationFrame(() => {
    if (!pool.has(opts.instanceId)) return; // released before we got here
    try {
      fit.fit();
    } catch {
      // not measurable yet; the ResizeObserver will fit shortly.
    }
    ptySpawn(opts.instanceId, output, opts.kind, opts.cwd, term.cols, term.rows)
      .then((result) => opts.onSpawned(result))
      .catch((e: unknown) => {
        opts.onError(e instanceof Error ? e.message : String(e));
        release(opts.instanceId); // failed spawn — don't leave a dead entry behind
      });
  });
  term.focus();
}

/** Re-measure and resize the terminal (and thus its PTY) to its container. */
export function refit(entryOrId: TermEntry | string): void {
  const entry = typeof entryOrId === "string" ? pool.get(entryOrId) : entryOrId;
  if (!entry) return;
  try {
    entry.fit.fit();
  } catch {
    // not measurable right now; ignore
  }
}

/**
 * Detach the instance's terminal from `container` without disposing it — used on
 * unmount (tab hidden / panel moved). The terminal keeps running in the pool. The
 * guard avoids yanking the host if a remount has already re-parented it elsewhere.
 */
export function detach(container: HTMLDivElement, instanceId: string): void {
  const entry = pool.get(instanceId);
  if (entry && entry.host.parentElement === container) {
    container.removeChild(entry.host);
  }
}

/**
 * Permanently close the instance's terminal: kill the PTY, dispose the terminal,
 * drop the pool entry. Idempotent. This is the *only* path that stops a PTY.
 */
export function release(instanceId: string): void {
  const entry = pool.get(instanceId);
  if (!entry) return;
  pool.delete(instanceId);
  entry.dataSub.dispose();
  entry.resizeSub.dispose();
  void ptyKill(instanceId);
  entry.term.dispose();
  entry.host.remove();
}
