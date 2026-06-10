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

import { activeTheme, deriveXtermTheme, mono } from "../theme/tokens";
import {
  ptyKill,
  ptyResize,
  ptySpawn,
  ptyWrite,
  type PtyChunk,
  type SpawnKind,
  type SpawnResult,
} from "../ipc/pty";
import { markInterrupted } from "../state/status";
import { mirrorInstanceTaskNote } from "../state/registry";

interface TermEntry {
  /** The element xterm renders into; re-parented across mounts, never recreated. */
  host: HTMLDivElement;
  term: Terminal;
  fit: FitAddon;
  dataSub: { dispose(): void };
  resizeSub: { dispose(): void };
  /** Listener that mirrors the agent's terminal title into the task note; only
   *  attached for claude consoles (see `acquire`). */
  titleSub?: { dispose(): void };
  /** Scroll position captured at the last `detach`, restored on re-attach so the
   *  viewport doesn't desync from the buffer (see `acquire`/`detach`). */
  scrollState?: { line: number; atBottom: boolean };
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

// --- task-note mirroring from the terminal title (OSC 0/2) ------------------
// Claude Code emits an OSC title sequence naming its current task; xterm parses
// it and fires `onTitleChange`. We debounce-mirror that into the instance's task
// note. The backend gates the write on a per-instance auto flag, so a manually
// edited note is never clobbered; here we only filter noise and rate-limit.

/** Debounce timers + last-sent title, keyed by instance id. */
const titleTimers = new Map<string, ReturnType<typeof setTimeout>>();
const lastMirroredTitle = new Map<string, string>();

/** Wait this long after the last title change before writing — Claude flips the
 *  title as it moves between sub-steps, and this lets it settle to the latest. */
const TITLE_MIRROR_DEBOUNCE_MS = 700;

function basename(p: string): string {
  const parts = p.replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts[parts.length - 1] ?? "";
}

/** Normalize a raw OSC title into a note, or null if it's empty/generic noise.
 *  Claude resets the title to the cwd or a bare "claude" when idle — neither is a
 *  useful note, so those are dropped rather than mirrored. */
function cleanTitle(raw: string, cwd: string): string | null {
  const t = raw
    // eslint-disable-next-line no-control-regex -- stripping C0/DEL bytes is the point
    .replace(/[\u0000-\u001F\u007F]/g, "") // strip stray control chars
    .replace(/\s+/g, " ")
    .trim();
  if (!t) return null;
  const lower = t.toLowerCase();
  if (lower === "claude" || lower === "claude code") return null;
  const base = basename(cwd).toLowerCase();
  if (base && lower === base) return null;
  return t;
}

function scheduleTitleMirror(instanceId: string, title: string): void {
  if (lastMirroredTitle.get(instanceId) === title) return; // already sent
  clearTimeout(titleTimers.get(instanceId));
  titleTimers.set(
    instanceId,
    setTimeout(() => {
      titleTimers.delete(instanceId);
      lastMirroredTitle.set(instanceId, title);
      void mirrorInstanceTaskNote(instanceId, title);
    }, TITLE_MIRROR_DEBOUNCE_MS),
  );
}

function clearTitleMirror(instanceId: string): void {
  clearTimeout(titleTimers.get(instanceId));
  titleTimers.delete(instanceId);
  lastMirroredTitle.delete(instanceId);
}

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
    // Re-parenting resets the `.xterm-viewport` DOM scrollTop to 0 while the
    // buffer stays scrolled where it was, so the scrollbar desyncs from the
    // rendered rows (pinned at the top, content showing the old position, and the
    // stale scroll area unable to reach the real bottom until a resize). A plain
    // `fit()` doesn't fix it — it's a no-op when the panel size is unchanged, so
    // it never re-syncs the viewport. Defer one frame so the re-attached element
    // has its final layout, then refit and re-sync: follow new output if it was at
    // the bottom (the common case for a live session), else restore the exact line.
    const saved = existing.scrollState;
    requestAnimationFrame(() => {
      if (pool.get(opts.instanceId) !== existing) return; // released/replaced
      refit(existing);
      const term = existing.term;
      // The re-parent reset the DOM viewport's scrollTop to 0, but xterm's buffer
      // model still believes it's at the old line — so a plain scrollToLine/
      // scrollToBottom to that same line computes a zero delta and no-ops, leaving
      // the scrollbar stuck at the top (and a live, bottom-pinned session looking
      // like it scrolled all the way up). Force a real move through the top first so
      // xterm re-syncs the viewport's scrollTop to the rendered rows.
      term.scrollToTop();
      if (!saved || saved.atBottom) term.scrollToBottom();
      else term.scrollToLine(saved.line);
      // Re-parenting the host moves xterm's <canvas> elements across DOM
      // containers, which desyncs the WebGL renderer's GPU glyph atlas: already-
      // painted cells keep showing stale/garbled glyphs until something marks them
      // dirty (which is why dragging a selection over them snaps them straight).
      // Rebuild the atlas and force a full repaint so the re-attached canvas paints
      // fresh. Harmless no-op for the DOM renderer (same as the font-load rebuild).
      term.clearTextureAtlas();
      term.refresh(0, term.rows - 1);
    });
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

  term.attachCustomKeyEventHandler((e) => {
    if (e.ctrlKey && e.shiftKey && e.code === "KeyC" && e.type === "keydown") {
      const sel = term.getSelection();
      if (sel) void navigator.clipboard.writeText(sel);
      return false; // prevent xterm from processing this key further
    }
    return true;
  });

  attachContextMenu(host, term);

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
    // A lone Esc / Ctrl+C in a claude console is an interrupt — and interrupting
    // fires no hook, so optimistically flip the dot to "done" (step 2.2). A lone
    // Esc is exactly "\x1b"; arrow keys etc. arrive as multi-byte escape sequences,
    // so this won't misfire on navigation.
    if (opts.kind === "claude" && (data === "\x1b" || data === "\x03")) {
      markInterrupted(opts.instanceId);
    }
  });
  const resizeSub = term.onResize(({ cols, rows }) => {
    void ptyResize(opts.instanceId, cols, rows);
  });

  // Mirror the agent's terminal title into the task note (live-mirror feature).
  // Claude Code names its current task via an OSC title sequence; xterm parses it
  // and fires this event. Only claude consoles drive the note — a plain shell sets
  // its title to the cwd, which isn't a task. The backend gates the actual write
  // on the instance's auto flag, so a manually edited note is never overwritten.
  let titleSub: { dispose(): void } | undefined;
  if (opts.kind === "claude") {
    titleSub = term.onTitleChange((raw) => {
      const clean = cleanTitle(raw, opts.cwd);
      if (clean) scheduleTitleMirror(opts.instanceId, clean);
    });
  }

  const entry: TermEntry = { host, term, fit, dataSub, resizeSub, titleSub };
  pool.set(opts.instanceId, entry);

  // The WebGL renderer bakes a glyph atlas at open time; if the bundled web font
  // (JetBrains Mono) hasn't finished loading yet, that atlas caches the fallback /
  // synthesized-bold glyphs, which sit on a wavy baseline and never refresh on
  // their own — only invalidated cells redraw, which is why dragging a selection
  // over a run snaps it straight. (The DOM renderer reflows on font-load by itself,
  // so this only bites WebGL.) Rebuild the atlas once the font is ready so every
  // cell repaints with the real face. Harmless no-op for the DOM renderer or if the
  // font was already loaded.
  void document.fonts.ready.then(() => {
    if (pool.get(opts.instanceId) !== entry) return; // released/replaced meanwhile
    term.clearTextureAtlas();
  });

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

/** Focus an instance's terminal, if it's in the pool (no-op otherwise). Used by
 *  the Shell panel's git quick-buttons to hand keyboard focus back to the shell
 *  after injecting a command. */
export function focusTerminal(instanceId: string): void {
  pool.get(instanceId)?.term.focus();
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
    // Capture scroll position before the DOM detach throws it away, so the
    // re-attach in `acquire` can restore it instead of snapping to a stale 0.
    const buf = entry.term.buffer.active;
    entry.scrollState = { line: buf.viewportY, atBottom: buf.viewportY >= buf.baseY };
    container.removeChild(entry.host);
  }
}

function attachContextMenu(host: HTMLDivElement, term: Terminal): void {
  host.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    showTermContextMenu(e.clientX, e.clientY, term);
  });
}

function showTermContextMenu(cx: number, cy: number, term: Terminal): void {
  document.querySelector(".wb-ctx-menu")?.remove();

  const { panel, border, text: fg, textDim2, sel: hoverBg } = activeTheme;
  const selection = term.getSelection();

  const menu = document.createElement("div");
  menu.className = "wb-ctx-menu";
  Object.assign(menu.style, {
    position: "fixed",
    zIndex: "9999",
    left: `${cx}px`,
    top: `${cy}px`,
    background: panel,
    border: `1px solid ${border}`,
    borderRadius: "4px",
    padding: "4px 0",
    minWidth: "120px",
    boxShadow: "0 4px 16px rgba(0,0,0,0.5)",
    fontFamily: mono,
    fontSize: "12px",
    visibility: "hidden",
  });

  function dismiss() {
    menu.remove();
    document.removeEventListener("mousedown", onOutside);
    document.removeEventListener("keydown", onEsc, true);
  }

  function addItem(label: string, enabled: boolean, action: () => void): void {
    const item = document.createElement("div");
    Object.assign(item.style, {
      padding: "5px 12px",
      cursor: enabled ? "pointer" : "default",
      color: enabled ? fg : textDim2,
      userSelect: "none",
    });
    item.textContent = label;
    if (enabled) {
      item.addEventListener("mouseenter", () => { item.style.background = hoverBg; });
      item.addEventListener("mouseleave", () => { item.style.background = ""; });
      item.addEventListener("mousedown", (e) => {
        e.preventDefault();
        dismiss();
        action();
      });
    }
    menu.appendChild(item);
  }

  addItem("Copy", selection.length > 0, () => {
    void navigator.clipboard.writeText(selection);
  });
  addItem("Paste", true, () => {
    void navigator.clipboard.readText().then((t) => term.paste(t));
  });

  const onOutside = (e: MouseEvent) => {
    if (!menu.contains(e.target as Node)) dismiss();
  };
  const onEsc = (e: KeyboardEvent) => {
    if (e.key === "Escape") { e.stopPropagation(); dismiss(); }
  };

  document.body.appendChild(menu);

  // Reposition after render so the menu doesn't bleed off-screen, then show.
  requestAnimationFrame(() => {
    const r = menu.getBoundingClientRect();
    if (r.right > window.innerWidth) menu.style.left = `${cx - r.width}px`;
    if (r.bottom > window.innerHeight) menu.style.top = `${cy - r.height}px`;
    menu.style.visibility = "visible";
  });

  // Delay listener so the triggering mousedown doesn't immediately dismiss.
  setTimeout(() => {
    document.addEventListener("mousedown", onOutside);
    document.addEventListener("keydown", onEsc, true);
  }, 0);
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
  entry.titleSub?.dispose();
  clearTitleMirror(instanceId);
  void ptyKill(instanceId);
  entry.term.dispose();
  entry.host.remove();
}
