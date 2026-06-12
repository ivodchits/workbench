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
  /** Fires when `host` is shown again after being hidden, to re-sync the viewport
   *  on a dockview tab switch (which detaches the DOM without a React lifecycle —
   *  see `acquire`). Disposed in `release`. */
  visSub?: IntersectionObserver;
  /** Scroll position captured at the last `detach`, restored on re-attach so the
   *  viewport doesn't desync from the buffer (see `acquire`/`detach`). */
  scrollState?: { line: number; atBottom: boolean };
}

/**
 * Re-sync the rendered viewport to xterm's buffer model after the host's DOM
 * scrollTop was reset to 0 (by a re-parent or a tab-switch re-attach). xterm's model
 * still holds the old line, so a plain scrollToLine to it computes a zero delta and
 * no-ops, leaving the scrollbar stuck at the top (a live, bottom-pinned session then
 * looks scrolled all the way up). Forcing a real move through the top first makes
 * xterm re-sync the DOM scrollTop to the rendered rows. Pass `saved` to restore an
 * exact pre-detach position; omit it to read the live model (the tab-switch case,
 * where the model was never disturbed). Also rebuilds the WebGL glyph atlas, which
 * the cross-container move desyncs (harmless no-op for the DOM renderer).
 */
function resyncViewport(entry: TermEntry, saved?: TermEntry["scrollState"]): void {
  refit(entry);
  const term = entry.term;
  const buf = term.buffer.active;
  const atBottom = saved ? saved.atBottom : buf.viewportY >= buf.baseY;
  const line = saved ? saved.line : buf.viewportY;
  term.scrollToTop();
  if (atBottom) term.scrollToBottom();
  else term.scrollToLine(line);
  term.clearTextureAtlas();
  term.refresh(0, term.rows - 1);
}

export interface AcquireOptions {
  instanceId: string;
  kind: SpawnKind;
  cwd: string;
  webgl: boolean;
  /** When set, resume that claude session (`claude --resume <id>`) instead of
   *  minting a fresh one (step 3.8). Null for a normal fresh launch / shell. */
  resumeSessionId: string | null;
  /** Called once, when the PTY spawn for a freshly created entry resolves. */
  onSpawned: (result: SpawnResult) => void;
  /** Called once, if that spawn fails (the entry is released). */
  onError: (message: string) => void;
}

const pool = new Map<string, TermEntry>();

// --- live theme + font-size re-application (step 3.9) ------------------------
// The appearance store (`state/appearance`) drives both: switching a theme preset
// re-derives every terminal's xterm theme, and Ctrl+wheel font scaling re-sizes
// every terminal. Terminals live outside React in this pool, so the store reaches
// them through these functions rather than a re-render.

/** The xterm font size at scale 1; the chrome's base is the same 13px feel. */
const BASE_FONT_SIZE = 13;

/** Current global font scale (1 = 100%). New terminals adopt it on `acquire`; an
 *  existing pool is rescaled by `rescaleAll`. Owned here so the store needn't be
 *  threaded through every `acquire` call. */
let currentScale = 1;

/**
 * Size one terminal to the global scale. The whole app is zoomed by `scale` at the
 * document root (so chrome + editor scale uniformly); a canvas/WebGL terminal would
 * blur under that zoom, so each terminal host *counter-zooms* by `1/scale` to render
 * at native resolution and instead grows its real `fontSize` to `BASE × scale`. Net
 * visual size matches the zoomed chrome while glyphs stay crisp. Refit so the PTY's
 * cols/rows track the new cell size.
 */
function applyScale(entry: TermEntry, scale: number): void {
  entry.host.style.zoom = String(1 / scale);
  entry.term.options.fontSize = Math.round(BASE_FONT_SIZE * scale);
  // Defer the refit one frame so the zoom + font change have reflowed before the
  // FitAddon measures (the container box is unchanged, so no ResizeObserver fires
  // to correct a stale fit). fontSize + counter-zoom also invalidate the WebGL
  // glyph atlas, so rebuild it after the resize.
  requestAnimationFrame(() => {
    refit(entry);
    entry.term.clearTextureAtlas();
  });
}

/** Re-apply `tokens`' derived xterm theme to every live terminal (theme switch). */
export function rethemeAll(): void {
  for (const entry of pool.values()) {
    entry.term.options.theme = deriveXtermTheme();
    entry.term.clearTextureAtlas();
    entry.term.refresh(0, entry.term.rows - 1);
  }
}

/** Set the global font scale and resize every live terminal to it (Ctrl+wheel). */
export function rescaleAll(scale: number): void {
  currentScale = scale;
  for (const entry of pool.values()) applyScale(entry, scale);
}

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
    // has its final layout, then refit and re-sync to the exact pre-detach position.
    const saved = existing.scrollState;
    requestAnimationFrame(() => {
      if (pool.get(opts.instanceId) !== existing) return; // released/replaced
      resyncViewport(existing, saved);
    });
    return;
  }

  const host = document.createElement("div");
  host.style.height = "100%";
  host.style.width = "100%";
  // Counter-zoom against the document-root zoom so glyphs render crisp (see
  // `applyScale`); the matching `fontSize` below gives the visual scale.
  host.style.zoom = String(1 / currentScale);
  container.appendChild(host);

  const term = new Terminal({
    fontFamily: mono,
    fontSize: Math.round(BASE_FONT_SIZE * currentScale),
    // Pin both weights to the exact faces bundled in global.css (400/700). xterm's
    // default `fontWeightBold: "bold"` lets the browser pick the nearest weight and,
    // if the real 700 face isn't loaded yet, synthesize one — the wavy-baseline bold.
    fontWeight: 400,
    fontWeightBold: 700,
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

  // Re-sync the viewport whenever the host is shown again after being hidden.
  // Switching dockview tabs detaches and re-attaches the panel DOM *without*
  // unmounting the React component, so `Console`'s detach/acquire (which drive the
  // re-sync above) never run — only this observer sees the tab-switch re-attach,
  // which like a re-parent resets the DOM scrollTop to 0 and desyncs the scrollbar.
  // Lives for the terminal's life (disposed in `release`); set up once here.
  const visSub = new IntersectionObserver((entries) => {
    if (!entries[entries.length - 1]?.isIntersecting) return;
    requestAnimationFrame(() => {
      if (pool.get(opts.instanceId) !== entry) return; // released/replaced
      resyncViewport(entry); // read the live model — the tab switch never disturbed it
    });
  });
  visSub.observe(host);
  entry.visSub = visSub;

  // The WebGL renderer bakes a glyph atlas at open time; if the bundled web font
  // (JetBrains Mono) hasn't finished loading yet, that atlas caches the fallback /
  // synthesized-bold glyphs, which sit on a wavy baseline and never refresh on
  // their own — only invalidated cells redraw, which is why dragging a selection
  // over a run snaps it straight. (The DOM renderer reflows on font-load by itself,
  // so this only bites WebGL.) Rebuild the atlas once the faces are ready so every
  // cell repaints with the real glyphs. Harmless no-op for the DOM renderer or if
  // the faces were already loaded.
  //
  // `document.fonts.ready` is NOT enough on its own: it only waits for faces already
  // in the loading pipeline, and the bold (700) face is lazy — nothing fetches it
  // until weight 700 is actually rendered. Open a console before any bold HTML has
  // pulled it in and `ready` resolves with only the regular face, the atlas rebakes
  // with *synthesized* bold, and the wavy bold persists. So explicitly `load()` both
  // weights (which forces the fetch) and only then rebuild.
  void Promise.all([
    document.fonts.load('400 13px "JetBrains Mono"'),
    document.fonts.load('700 13px "JetBrains Mono"'),
  ]).then(() => {
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
    ptySpawn(
      opts.instanceId,
      output,
      opts.kind,
      opts.cwd,
      opts.resumeSessionId,
      term.cols,
      term.rows,
    )
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
 *  after injecting a command, and by `routePanelFocus` on every panel-focus change. */
export function focusTerminal(instanceId: string): void {
  const entry = pool.get(instanceId);
  if (!entry) return;
  entry.term.focus();
  // Focusing xterm's helper textarea makes the browser scroll `.xterm-viewport` to
  // bring it into view, resetting the DOM scrollTop to 0 while the buffer model stays
  // put — the same scrollbar desync a re-parent/tab-switch causes, but here with no
  // detach/re-attach or visibility change to trigger a re-sync. This only bites when
  // the terminal is *already* visible: two consoles side-by-side, where switching
  // focus between them neither hides nor remounts either one, so neither the
  // detach/acquire path nor the visibility observer runs (the scrollbar snaps to the
  // top while the rows stay put). Tabbed / other-project switches recover via those
  // paths already. Re-sync on the next frame, once the focus-scroll has landed.
  requestAnimationFrame(() => {
    if (pool.get(instanceId) !== entry) return; // released/replaced
    resyncViewport(entry); // read the live model — focus never disturbed it
  });
}

/**
 * Insert `text` into an instance's live terminal as a **bracketed paste**, routed
 * through xterm's normal `onData` → PTY path (so it's identical to a real paste).
 * Bracketed paste is what makes multi-line prompts safe: the `claude` TUI receives
 * the whole block as one paste rather than submitting at the first newline. Used by
 * the prompt-template library (step 3.4) to land a resolved prompt in a console
 * without sending it (the caller writes a trailing `\r` separately to submit).
 * Focuses the terminal and returns false if the instance has no live terminal.
 */
export function pasteIntoTerminal(instanceId: string, text: string): boolean {
  const entry = pool.get(instanceId);
  if (!entry) return false;
  entry.term.paste(text);
  entry.term.focus();
  return true;
}

/**
 * Land `text` in the instance's live terminal **and submit it** (a trailing CR) —
 * the shared "insert & send" path. Used by the prompt queue (step 3.5) both to
 * send a queued prompt the instant the agent finishes its turn and to send one
 * straight away when the agent is already at rest. Returns false if the instance
 * has no live terminal (so the caller can keep the prompt queued / surface it).
 */
export function submitToTerminal(instanceId: string, text: string): boolean {
  if (!pasteIntoTerminal(instanceId, text)) return false;
  void ptyWrite(instanceId, new TextEncoder().encode("\r"));
  return true;
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
  entry.visSub?.disconnect();
  entry.dataSub.dispose();
  entry.resizeSub.dispose();
  entry.titleSub?.dispose();
  clearTitleMirror(instanceId);
  void ptyKill(instanceId);
  entry.term.dispose();
  entry.host.remove();
}
