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
  CLEAR_INPUT_KEY,
  ENTER_KEY,
  NEWLINE_KEY,
  ptyKill,
  ptyResize,
  ptySpawn,
  ptySubscribe,
  ptyUnsubscribe,
  ptyWrite,
  type PtyChunk,
  type RemoteSpawn,
  type SpawnKind,
  type SpawnResult,
  type Subscribed,
  type TaskSpawn,
} from "../ipc/pty";
import { deletePastedImages, pastedImageDir } from "../ipc/os";
import { encodePaste, promptChunks } from "../state/composer";
import { markInterrupted } from "../state/status";
import { mirrorInstanceTaskNote } from "../state/registry";
import { takeLaunchPrompt } from "../state/launchPrompt";
import { isHeadless, sendHeadless } from "../state/headless";
import { isSpeaking, speak, stopSpeaking } from "../util/speech";

interface TermEntry {
  /** The element xterm renders into; re-parented across mounts, never recreated. */
  host: HTMLDivElement;
  term: Terminal;
  fit: FitAddon;
  dataSub: { dispose(): void };
  /** Stamps `typedAt` on each key the user presses in this terminal. */
  keySub: { dispose(): void };
  resizeSub: { dispose(): void };
  /** This terminal's PTY output subscription id (step 4.1), set once `ptySubscribe`
   *  resolves after spawn. Passed to `ptyResize` (min-size arbitration) and to
   *  `ptyUnsubscribe` in `release`. Undefined until the subscription lands. */
  subId?: number;
  /** True while a terminal attached to a live PTY is still being filled with its
   *  replayed scrollback. It is held at the PTY's size until that is done (see
   *  `acquire`), so nothing may resize it. */
  replaying?: boolean;
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
  rebuildAtlas();
  term.refresh(0, term.rows - 1);
}

/**
 * Throw away the WebGL glyph atlas and have every terminal redraw from a fresh one.
 *
 * Always for the whole pool, never for one terminal: xterm shares a single atlas
 * between all terminals with the same font and colours, but `clearTextureAtlas` only
 * makes the terminal it is called on forget where its glyphs were. The others keep
 * drawing from the old positions in a texture that has since been wiped and refilled
 * in another order, so they show the wrong glyphs or nothing until something forces
 * them to redraw in full (step C2). Calling it on each one is cheap: the atlas is
 * wiped by the first call and found empty by the rest, which then only drop their
 * own stale positions. No-op for a terminal on the DOM renderer.
 */
function rebuildAtlas(): void {
  for (const entry of pool.values()) entry.term.clearTextureAtlas();
}

export interface AcquireOptions {
  instanceId: string;
  kind: SpawnKind;
  cwd: string;
  webgl: boolean;
  /** When set, resume that claude session (`claude --resume <id>`) instead of
   *  minting a fresh one (step 3.8). Null for a normal fresh launch / shell. */
  resumeSessionId: string | null;
  /** When set, drive a remote claude over SSH+tmux instead of a local child
   *  (step 3.12). Null for a local launch / shell. */
  remote: RemoteSpawn | null;
  /** The plugin action a `task` PTY runs (step K1). */
  task?: TaskSpawn | null;
  /**
   * Attach to an **already-live** PTY instead of spawning a new child (step 4.2 —
   * OS-window tear-off). True for a torn-off window's terminal and for docking a
   * torn-off panel back into the main dock: in both cases the PTY is already running
   * (keyed by `instanceId`), so we only `pty_subscribe` to it and replay its ring
   * buffer rather than launch `claude`/the shell again. False = the normal spawn path.
   */
  attach?: boolean;
  /** Called once, when the PTY spawn for a freshly created entry resolves. */
  onSpawned: (result: SpawnResult) => void;
  /** Called once, after `attach` mode successfully subscribes to the live PTY. */
  onAttached?: () => void;
  /** Called once, if that spawn (or attach) fails (the entry is released). */
  onError: (message: string) => void;
}

const pool = new Map<string, TermEntry>();

// The instance whose terminal most recently held focus — the target for the
// `speakSelection` command (Ctrl+Shift+L / command palette). Tracked here rather
// than read from `document.activeElement` at call time because the command can be
// invoked from the palette overlay, which has since taken DOM focus; the terminal
// selection itself lives in xterm's buffer and survives the focus move.
let lastFocusedInstanceId: string | null = null;

/**
 * Read the last-focused terminal's selection aloud, or stop an in-progress read
 * (a toggle, so the same key silences a long one). The `speakSelection` command's
 * action — see `keyboard/commands`. No-op if nothing was ever focused or the
 * focused terminal has no selection.
 */
export function speakFocusedSelection(): void {
  if (isSpeaking()) {
    stopSpeaking();
    return;
  }
  const entry = lastFocusedInstanceId ? pool.get(lastFocusedInstanceId) : null;
  const sel = entry?.term.getSelection();
  if (sel) speak(sel);
}

// --- live theme + font-size re-application (step 3.9) ------------------------
// The appearance store (`state/appearance`) drives both: switching a theme preset
// re-derives every terminal's xterm theme, and Ctrl+wheel font scaling re-sizes
// every terminal. Terminals live outside React in this pool, so the store reaches
// them through these functions rather than a re-render.

/** The xterm font size at scale 1; the chrome's base is the same 13px feel. */
const BASE_FONT_SIZE = 13;

/** Lines of scrollback each console keeps (xterm's default is 1,000 — shorter than
 *  one long agent turn). The single place to tune it. */
const SCROLLBACK_LINES = 10_000;

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
    rebuildAtlas();
  });
}

/** Re-apply `tokens`' derived xterm theme to every live terminal (theme switch). */
export function rethemeAll(): void {
  for (const entry of pool.values()) {
    entry.term.options.theme = deriveXtermTheme();
  }
  rebuildAtlas();
  for (const entry of pool.values()) entry.term.refresh(0, entry.term.rows - 1);
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

  // Record this terminal as the speak-selection target whenever it takes focus
  // (clicking into it to select, or a programmatic focus). `focusin` bubbles from
  // xterm's helper textarea, so one listener on the host covers every focus path.
  host.addEventListener("focusin", () => {
    lastFocusedInstanceId = opts.instanceId;
  });

  const term = new Terminal({
    fontFamily: mono,
    fontSize: Math.round(BASE_FONT_SIZE * currentScale),
    // Pin both weights to the exact faces bundled in global.css (400/700). xterm's
    // default `fontWeightBold: "bold"` lets the browser pick the nearest weight and,
    // if the real 700 face isn't loaded yet, synthesize one — the wavy-baseline bold.
    fontWeight: 400,
    fontWeightBold: 700,
    cursorBlink: true,
    scrollback: SCROLLBACK_LINES,
    theme: deriveXtermTheme(),
    allowProposedApi: true,
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.open(host);

  term.attachCustomKeyEventHandler((e) => {
    // Shift+Enter in a claude console inserts a line break instead of submitting
    // (xterm would otherwise send a plain CR). Swallow every phase of the key —
    // keydown writes the sequence, keypress/keyup are dropped — so xterm doesn't
    // additionally send `\r`. Shells keep the default.
    if (
      opts.kind === "claude" &&
      e.key === "Enter" &&
      e.shiftKey &&
      !e.ctrlKey &&
      !e.altKey &&
      !e.metaKey
    ) {
      if (e.type === "keydown") {
        e.preventDefault();
        void ptyWrite(opts.instanceId, NEWLINE_KEY);
      }
      return false;
    }

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

  // This terminal's PTY output subscription id (step 4.1), assigned once
  // `ptySubscribe` resolves below. Held in a closure-local so `onResize` can read
  // it without a forward reference to `entry`; mirrored onto `entry.subId` for
  // `release` to unsubscribe.
  let subId: number | undefined;

  // Attaching to a live PTY (step C3): the scrollback it replays was laid out for the
  // PTY's size as each byte was written, not for whatever this panel measures. Written
  // into a terminal of another width its lines wrap, the TUI's cursor moves land on the
  // wrong rows, and each redraw is painted over part of the one before. So the terminal
  // starts at the size the replay starts at, takes each resize the PTY took at the byte
  // it fell on (`resizes`) — replaying what the terminal that watched live went
  // through — and only then is fitted to the panel: an ordinary resize, which xterm
  // reflows and the TUI redraws for. Output that arrives before the sizes are known is
  // held back; `received` tells when the replay is all in (the channel and the
  // subscribe result aren't ordered against each other).
  let held: Uint8Array[] | null = opts.attach ? [] : null;
  let received = 0;
  let replayLen = Infinity;
  let resizes: Subscribed["resizes"] = [];
  let written = 0;
  const writeOut = (bytes: Uint8Array) => {
    let from = 0;
    while (resizes.length > 0 && resizes[0].at - written <= bytes.length) {
      const { at, cols, rows } = resizes.shift()!;
      // The callback runs once these bytes are parsed and before any written after.
      term.write(bytes.subarray(from, at - written), () => term.resize(cols, rows));
      from = at - written;
    }
    if (from < bytes.length) term.write(from > 0 ? bytes.subarray(from) : bytes);
    written += bytes.length;
  };
  const endReplay = () => {
    replayLen = Infinity; // once only
    // The empty write's callback runs after everything queued before it is parsed.
    term.write("", () => {
      if (pool.get(opts.instanceId) !== entry) return; // released meanwhile
      entry.replaying = false;
      refit(entry);
      // Vote this terminal's size into the arbitration whether or not the fit
      // changed it (an unchanged size fires no `onResize`).
      void ptyResize(opts.instanceId, term.cols, term.rows, subId);
    });
  };

  const output = new Channel<PtyChunk>();
  output.onmessage = (chunk) => {
    const bytes = new Uint8Array(chunk);
    received += bytes.length;
    if (held) held.push(bytes);
    else writeOut(bytes);
    if (received >= replayLen) endReplay();
  };

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
  // Keys only: a paste the app makes (`pasteIntoTerminal`) comes through `onData`
  // but isn't the user typing.
  const keySub = term.onKey(() => typedAt.set(opts.instanceId, Date.now()));
  const resizeSub = term.onResize(({ cols, rows }) => {
    // Taking the PTY's own size for a replay is not a request to resize it.
    if (pool.get(opts.instanceId)?.replaying) return;
    // Carry the subscription id so this terminal's size joins the PTY's min-size
    // arbitration (step 4.1). Before the subscription lands, `subId` is undefined
    // and the resize falls through to a direct PTY resize — harmless, and the seed
    // resize after `ptySubscribe` re-asserts the arbitrated size.
    void ptyResize(opts.instanceId, cols, rows, subId);
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

  const entry: TermEntry = { host, term, fit, dataSub, keySub, resizeSub, titleSub };
  entry.replaying = !!opts.attach;
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
    rebuildAtlas();
  });

  // Defer the first fit + spawn one frame so xterm has rendered and the addon can
  // measure char size; then spawn the child at the fitted dimensions.
  requestAnimationFrame(() => {
    if (!pool.has(opts.instanceId)) return; // released before we got here
    if (opts.attach) {
      // Step 4.2: the PTY is already live (a torn-off window, or a panel being
      // docked back into the main dock). Don't spawn — just attach as another
      // multiplexer subscriber (step 4.1), which replays the ring buffer so this
      // terminal paints the in-flight session. A failure means the child is gone.
      // No fit yet: the replay goes in at the PTY's size first (see `held` above).
      ptySubscribe(opts.instanceId, output)
        .then((sub) => {
          if (pool.get(opts.instanceId) !== entry) {
            void ptyUnsubscribe(opts.instanceId, sub.subId); // released while subscribing
            return;
          }
          subId = sub.subId;
          entry.subId = sub.subId;
          term.resize(sub.cols, sub.rows);
          resizes = sub.resizes;
          for (const bytes of held ?? []) writeOut(bytes);
          held = null;
          replayLen = sub.replayLen;
          if (received >= replayLen) endReplay();
          opts.onAttached?.();
        })
        .catch((e: unknown) => {
          opts.onError(e instanceof Error ? e.message : String(e));
          release(opts.instanceId); // no live PTY to attach to — drop the dead entry
        });
      return;
    }
    try {
      fit.fit();
    } catch {
      // not measurable yet; the ResizeObserver will fit shortly.
    }
    ptySpawn(
      opts.instanceId,
      opts.kind,
      opts.cwd,
      opts.resumeSessionId,
      opts.remote,
      term.cols,
      term.rows,
      opts.task ?? null,
      // A prompt waiting for this launch goes on claude's command line.
      opts.kind === "claude" && !opts.remote ? takeLaunchPrompt(opts.instanceId) : null,
    )
      .then(async (result) => {
        opts.onSpawned(result);
        // The PTY now exists; attach this terminal as a subscriber (step 4.1). The
        // backend replays the ring buffer into `output` on attach, so a session
        // that produced output between spawn and here isn't lost. Guard against a
        // release that raced in before the spawn resolved.
        if (pool.get(opts.instanceId) !== entry) return;
        const { subId: id } = await ptySubscribe(opts.instanceId, output);
        if (pool.get(opts.instanceId) !== entry) {
          // Released while subscribing — detach the just-created subscriber.
          void ptyUnsubscribe(opts.instanceId, id);
          return;
        }
        subId = id;
        entry.subId = id;
        // Seed this subscriber's size into the min-size arbitration now that it's
        // registered (the initial fit's `onResize` may have fired before `subId`
        // was set and thus resized the PTY directly rather than as a subscriber).
        void ptyResize(opts.instanceId, term.cols, term.rows, id);
      })
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
 * Whatever is already in the TUI's input is cleared first (`clearInput`), so a
 * prompt an interrupt left there isn't sent along with this one.
 */
export function submitToTerminal(instanceId: string, text: string): boolean {
  if (isHeadless(instanceId)) {
    // A headless worker (D4) takes it as a protocol message.
    void sendHeadless(instanceId, text).catch(() => {});
    return true;
  }
  const entry = pool.get(instanceId);
  if (!entry) return false;
  void clearInput(instanceId)
    .then(async () => {
      if (pool.get(instanceId) !== entry) return; // released meanwhile
      const landed = await pasteChunks(
        text,
        (chunk) => void pasteIntoTerminal(instanceId, chunk),
        (count) => imageLanded(instanceId, count),
      );
      await settle(PASTE_SETTLE_MS);
      await ptyWrite(instanceId, ENTER_KEY);
      // The TUI holds a landed image in memory: its file has done its job.
      if (landed.length > 0) void deletePastedImages(landed);
    })
    .catch(() => {}); // the PTY is gone: nothing to send to
  return true;
}

/**
 * Send `text` to the instance's session as a prompt, whether or not this window
 * holds a terminal for it. The transcript view can be on screen with no pooled
 * terminal at all — a console docked back from its own window, or a torn-off
 * window that opened straight into the transcript — so when there is none the
 * same bytes a paste produces are written to the PTY directly. With no screen to
 * watch, an image is given a fixed time to load and its file is left for the
 * startup prune.
 */
export function submitPrompt(instanceId: string, text: string): void {
  if (submitToTerminal(instanceId, text)) return;
  void clearInput(instanceId)
    .then(() =>
      pasteChunks(
        text,
        (chunk) => ptyWrite(instanceId, encodePaste(chunk)),
        () => new Promise<boolean>((resolve) => setTimeout(() => resolve(false), IMAGE_SETTLE_MS)),
      ),
    )
    .then(() => settle(PASTE_SETTLE_MS))
    .then(() => ptyWrite(instanceId, ENTER_KEY))
    .catch(() => {}); // no such PTY: the session is gone, nothing to send to
}

/** How long an image pasted with no screen to watch is given to load. */
const IMAGE_SETTLE_MS = 1000;
/** How long to watch the screen for a pasted image's chip before going on. */
const IMAGE_LOAD_TIMEOUT_MS = 5000;

let imageDir: Promise<string> | null = null;

/**
 * Paste `text` with `paste`, its image tokens (`state/composer`) as their files'
 * paths, each on its own — the TUI turns a paste that is just an image path into
 * an `[Image #N]` attachment. The TUI loads the image asynchronously and an Enter
 * sent meanwhile goes without it, so after each image `landed(n)` waits until the
 * input holds `n` attachments (false: it didn't see them). Resolves with the
 * images known to have landed.
 */
async function pasteChunks(
  text: string,
  paste: (chunk: string) => unknown,
  landed: (count: number) => Promise<boolean>,
): Promise<string[]> {
  const chunks = promptChunks(text);
  if (!chunks.some((c) => c.kind === "image")) {
    await paste(text);
    return [];
  }
  imageDir ??= pastedImageDir();
  const dir = await imageDir;
  const sent: string[] = [];
  let count = 0;
  for (const chunk of chunks) {
    if (chunk.kind === "text") {
      await paste(chunk.text);
      continue;
    }
    await paste(`${dir}${dir.includes("\\") ? "\\" : "/"}${chunk.name}`);
    if (await landed(++count)) sent.push(chunk.name);
  }
  return sent;
}

/** Wait until the TUI's input shows `count` image attachments; false on timeout. */
function imageLanded(instanceId: string, count: number): Promise<boolean> {
  const deadline = Date.now() + IMAGE_LOAD_TIMEOUT_MS;
  return new Promise((resolve) => {
    const check = () => {
      const screen = readScreen(instanceId);
      if (!screen) return resolve(false);
      if (inputAttachments(screen) >= count) return resolve(true);
      if (Date.now() > deadline) return resolve(false);
      setTimeout(check, 50);
    };
    check();
  });
}

/** The `[Image #N]` chips in the TUI's input box: below its last `❯` prompt row
 *  (earlier prompts on screen carry chips of their own). */
function inputAttachments(screen: string[]): number {
  let from = 0;
  for (let y = screen.length - 1; y >= 0; y--) {
    if (screen[y].trimStart().startsWith("❯")) {
      from = y;
      break;
    }
  }
  return screen.slice(from).reduce((n, row) => n + row.split("[Image #").length - 1, 0);
}

/** How long the cleared input is left before the prompt is pasted. Arriving in one
 *  chunk with the paste and its Enter — likely mid-turn, while the TUI is busy
 *  drawing — the Ctrl+U burst makes the TUI take the Enter as part of the paste,
 *  and the prompt sits in the input unsent. 30 ms was enough in a scratch PTY. */
const CLEAR_SETTLE_MS = 50;
/** How long a pasted prompt is left before its Enter, for the same reason: read in
 *  one chunk with the paste by a busy TUI (finishing a compaction, say), the Enter
 *  becomes a newline in the input instead of a submit. */
const PASTE_SETTLE_MS = 50;

const settle = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Empty the TUI's input (`CLEAR_INPUT_KEY`), then give it a moment to settle. */
function clearInput(instanceId: string): Promise<void> {
  return ptyWrite(instanceId, CLEAR_INPUT_KEY).then(() => settle(CLEAR_SETTLE_MS));
}

/**
 * The text of the instance's terminal screen, one string per row (the last
 * `rows` lines of the buffer, not the scrollback), or null when this window holds
 * no terminal for it. The one place terminal output is read back: the choice card
 * (step T5) takes a permission prompt's option labels from it, because the hooks
 * don't carry them. What the session is *doing* still comes from hooks only.
 */
export function readScreen(instanceId: string): string[] | null {
  const entry = pool.get(instanceId);
  if (!entry) return null;
  const buf = entry.term.buffer.active;
  const out: string[] = [];
  for (let y = buf.baseY; y < buf.baseY + entry.term.rows; y++) {
    out.push(buf.getLine(y)?.translateToString(true) ?? "");
  }
  return out;
}

/** instance id → when the user last pressed a key in its terminal, epoch ms. */
const typedAt = new Map<string, number>();

/** When the user last pressed a key in the instance's terminal in this window
 *  (epoch ms), or null: Duck's keys (W6) never go in while you're typing. */
export function lastTypedAt(instanceId: string): number | null {
  return typedAt.get(instanceId) ?? null;
}

/** The last `n` lines with text in the instance's terminal (scrollback included),
 *  or null when this window holds no terminal for it: what a task printed last,
 *  for Duck's report when a run ends (W5). */
export function readTail(instanceId: string, n: number): string[] | null {
  const entry = pool.get(instanceId);
  if (!entry) return null;
  const buf = entry.term.buffer.active;
  let end = buf.length;
  while (end > 0 && !(buf.getLine(end - 1)?.translateToString(true) ?? "").trim()) end--;
  const out: string[] = [];
  for (let y = Math.max(0, end - n); y < end; y++) out.push(buf.getLine(y)?.translateToString(true) ?? "");
  return out;
}

/** How long a console's box has to hold still before its terminal is resized to it. */
const RESIZE_SETTLE_MS = 120;

/** Pending `refitSoon` timers, keyed by instance id. */
const resizeTimers = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * Refit once the console's box has stopped changing — what its ResizeObserver calls.
 *
 * Dragging a splitter changes the box on every frame, and fitting each time sent the
 * PTY dozens of resizes per drag. The TUI redraws on each one, and every redraw can
 * leave a stale copy of the screen behind in the scrollback, so one drag left dozens
 * (step C3). The terminal — not just the PTY — waits: resized on its own it would
 * wrap output still being laid out for the old width. Until the drag pauses it keeps
 * its old size, clipped or with a margin.
 */
export function refitSoon(instanceId: string): void {
  clearTimeout(resizeTimers.get(instanceId));
  resizeTimers.set(
    instanceId,
    setTimeout(() => {
      resizeTimers.delete(instanceId);
      refit(instanceId);
    }, RESIZE_SETTLE_MS),
  );
}

/** Re-measure and resize the terminal (and thus its PTY) to its container. */
export function refit(entryOrId: TermEntry | string): void {
  const entry = typeof entryOrId === "string" ? pool.get(entryOrId) : entryOrId;
  if (!entry || entry.replaying) return;
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
  // Read the selection aloud (Ctrl+Shift+L), or stop an in-progress read. Enabled
  // when there's a selection to speak or something is already speaking.
  const speaking = isSpeaking();
  addItem(speaking ? "Stop speaking" : "Speak selection", speaking || selection.length > 0, () => {
    if (speaking) stopSpeaking();
    else speak(selection);
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
 * Dispose the instance's terminal and drop the pool entry. Idempotent.
 *
 * By default this also **kills the PTY** — the usual "console closed" teardown, and
 * the only path that stops a child. Pass `{ keepPty: true }` to dispose only the
 * terminal (unsubscribing this webview from the multiplexer) while leaving the child
 * running: that's the OS-window tear-off case (step 4.2) — the main dock's terminal
 * goes away but the PTY lives on with the torn-off window as its subscriber, and a
 * later dock-back re-`acquire`s in `attach` mode.
 */
export function release(instanceId: string, opts?: { keepPty?: boolean }): void {
  const entry = pool.get(instanceId);
  if (!entry) return;
  pool.delete(instanceId);
  if (lastFocusedInstanceId === instanceId) lastFocusedInstanceId = null;
  entry.visSub?.disconnect();
  entry.dataSub.dispose();
  entry.keySub.dispose();
  typedAt.delete(instanceId);
  entry.resizeSub.dispose();
  entry.titleSub?.dispose();
  clearTitleMirror(instanceId);
  clearTimeout(resizeTimers.get(instanceId));
  resizeTimers.delete(instanceId);
  // Detach this terminal's output subscription. When killing, `ptyKill` tears the
  // whole PTY (and its hub) down anyway, but unsubscribing first keeps the contract
  // clean and avoids a late fanout into a disposed terminal. When keeping the PTY
  // (tear-off), this is essential — it removes the now-gone terminal's size vote from
  // the min-size arbitration (step 4.1) so it can't constrain the torn-off window.
  if (entry.subId !== undefined) void ptyUnsubscribe(instanceId, entry.subId);
  if (!opts?.keepPty) void ptyKill(instanceId);
  entry.term.dispose();
  entry.host.remove();
}
