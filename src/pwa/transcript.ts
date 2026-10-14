// The phone's transcript view (step R4) — the conversation half of the console
// overlay (`console.ts`), and what it opens on.
//
// The desktop's own pieces do the work: `transcript/feed` joins history to the live
// stream and `transcript/render` draws it, here over the `/api/transcript` socket
// (`transcriptSource`). This module is the chrome: scrolling that sticks to the end,
// "load earlier", the status line, the needs-you row and the composer, which sends
// the dashboard's ordinary `prompt` action.

import type { RemoteInstance } from "../remote/protocol";
import { createFeed, type Feed } from "../transcript/feed";
import { createRenderer, type TranscriptRenderer } from "../transcript/render";
import { $ } from "./dom";
import { phaseOf } from "./format";
import { action, openSocket } from "./net";
import { transcriptSource } from "./transcriptSource";

/** Closer than this to the end counts as "at the bottom". */
const STICK_PX = 48;
/** The composer grows with its text up to this share of the screen. */
const COMPOSER_MAX_VH = 0.35;

let current: string | null = null;
let feed: Feed | null = null;
let renderer: TranscriptRenderer | null = null;
/** The reader was at the end as of their last scroll. */
let stuck = true;
let live: RemoteInstance | undefined;
/** Unsent text per instance, kept while the overlay is closed or switched. */
const drafts = new Map<string, string>();
let onLink: (text: string) => void = () => {};
/** The feed's connection state, as last reported. */
let linkText = "";
let switchToTerminal: () => void = () => {};

function scroller(): HTMLElement {
  return $("tx-scroll");
}

function atBottom(): boolean {
  const s = scroller();
  return s.scrollHeight - s.scrollTop - s.clientHeight < STICK_PX;
}

function toEnd(): void {
  const s = scroller();
  s.scrollTop = s.scrollHeight;
}

function setAway(away: boolean): void {
  $("tx-jump").classList.toggle("hidden", !away);
}

/** Repaint after the feed changed, keeping the reader's place. */
function changed(why: string): void {
  if (!feed || !renderer) return;
  const s = scroller();
  const follow = why === "reset" || stuck;
  const height = s.scrollHeight;
  const top = s.scrollTop;
  if (why !== "loading") renderer.update(feed.items);
  const earlier = $<HTMLButtonElement>("tx-earlier");
  earlier.classList.toggle("hidden", !feed.hasEarlier);
  earlier.disabled = feed.loading;
  earlier.textContent = feed.loading ? "loading…" : "↑ load earlier";
  const empty = $("tx-empty");
  empty.classList.toggle("hidden", feed.items.length > 0);
  empty.textContent = !feed.ready || feed.loading ? "loading…" : "nothing in this session yet";
  if (follow) toEnd();
  else if (why === "prepend") s.scrollTop = top + (s.scrollHeight - height);
  stuck = follow;
  setAway(!follow);
}

/** The status line, the needs-you row and the composer's buttons, from the latest
 *  snapshot of the instance. */
function paintStatus(): void {
  const it = live;
  const phase = it ? phaseOf(it) : "idle";
  const status = $("tx-status");
  if (it?.compacting) {
    status.className = "working";
    status.textContent = "◐ compacting…";
  } else if (phase === "working") {
    status.className = "working";
    const n = it?.subagents ?? 0;
    status.textContent = `◐ working${n > 0 ? ` · ${n} subagent${n === 1 ? "" : "s"}` : ""}`;
  } else {
    status.className = "";
    status.textContent = "";
  }
  $("tx-needs").classList.toggle("hidden", phase !== "needs_you");
  $("tx-stop").classList.toggle("hidden", phase !== "working");
  const running = it?.live ?? false;
  const text = $<HTMLTextAreaElement>("tx-text");
  text.placeholder = running ? "message Claude…" : "session not running";
  $("tx-send").textContent = running ? "send" : "start";
  if (stuck) toEnd();
}

/** Grow the composer with its text, up to a cap; past it, it scrolls. */
function fitComposer(): void {
  const text = $<HTMLTextAreaElement>("tx-text");
  text.style.height = "auto";
  text.style.height = `${Math.min(text.scrollHeight + 2, window.innerHeight * COMPOSER_MAX_VH)}px`;
}

function send(): void {
  if (!current) return;
  const text = $<HTMLTextAreaElement>("tx-text");
  if (!live?.live) {
    // Nowhere for a prompt to go yet; the desktop would start the console and drop
    // the text. Start it, and keep the text for when it is up.
    action({ type: "start", instanceId: current });
    return;
  }
  const body = text.value.trim();
  if (!body) return;
  action({ type: "prompt", instanceId: current, text: body });
  text.value = "";
  drafts.delete(current);
  fitComposer();
  // The prompt will appear at the end: go there.
  stuck = true;
  setAway(false);
  toEnd();
}

function report(text: string): void {
  linkText = text;
  onLink(text);
}

/** Show an instance's conversation. Keeps running while the terminal is shown
 *  instead, so switching back is instant. */
export function showTranscript(id: string, it: RemoteInstance | undefined): void {
  live = it;
  if (current !== id) {
    hideTranscript();
    current = id;
    stuck = true;
    renderer = createRenderer($("tx-list"));
    const source = transcriptSource(id, {
      open: (params) => openSocket("/api/transcript", params),
      onLink: (up) => report(up ? "● live" : "○ reconnecting…"),
    });
    report("connecting…");
    feed = createFeed(source, changed);
    const text = $<HTMLTextAreaElement>("tx-text");
    text.value = drafts.get(id) ?? "";
    fitComposer();
    changed("reset");
  } else {
    onLink(linkText); // back from the terminal: say where the feed stands
  }
  paintStatus();
}

/** A new snapshot of the shown instance. */
export function updateTranscript(it: RemoteInstance | undefined): void {
  if (!current) return;
  live = it;
  paintStatus();
}

/** Stop the feed and clear the view (the overlay closed). */
export function hideTranscript(): void {
  if (current) {
    const text = $<HTMLTextAreaElement>("tx-text").value;
    if (text.trim()) drafts.set(current, text);
    else drafts.delete(current);
  }
  feed?.stop();
  feed = null;
  renderer?.clear();
  renderer = null;
  current = null;
}

/** Wire the view's controls. `link` shows its connection state; `terminal` switches
 *  the overlay to the mirrored terminal. */
export function initTranscript(link: (text: string) => void, terminal: () => void): void {
  onLink = link;
  switchToTerminal = terminal;
  const s = scroller();
  s.addEventListener(
    "scroll",
    () => {
      stuck = atBottom();
      setAway(!stuck);
    },
    { passive: true },
  );
  // The keyboard opening (or the composer growing) shrinks the view; a reader at
  // the end stays there.
  new ResizeObserver(() => {
    if (stuck) toEnd();
  }).observe(s);
  // Rendered links are untrusted text: web and mail links open in a new tab, as the
  // renderer marked them; nothing else goes anywhere.
  s.addEventListener("click", (e) => {
    const link = e.target instanceof Element ? e.target.closest("a[href]") : null;
    if (link && !/^(https?:|mailto:)/i.test(link.getAttribute("href") ?? "")) e.preventDefault();
  });
  $("tx-earlier").onclick = () => void feed?.loadEarlier();
  $("tx-jump").onclick = () => {
    stuck = true;
    setAway(false);
    toEnd();
  };
  const text = $<HTMLTextAreaElement>("tx-text");
  text.addEventListener("input", () => {
    fitComposer();
    if (current) drafts.set(current, text.value);
  });
  // Enter is a new line, as on any phone keyboard; the button sends. A hardware
  // keyboard can send with Ctrl/⌘+Enter.
  text.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      send();
    }
  });
  const send_ = $("tx-send");
  // Tapping send must not close the on-screen keyboard: a follow-up is often next.
  send_.addEventListener("pointerdown", (e) => {
    if (document.activeElement === text) e.preventDefault();
  });
  send_.onclick = send;
  $("tx-stop").onclick = () => {
    if (current) action({ type: "interrupt", instanceId: current });
  };
  for (const type of ["approve", "deny"] as const) {
    $(`tx-${type}`).onclick = () => {
      if (current) action({ type, instanceId: current });
    };
  }
  $("tx-answer").onclick = () => switchToTerminal();
}
