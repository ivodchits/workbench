// The mirrored live console (step 4.5, design §11 Phase B) — the terminal half of
// the console overlay (`console.ts`).
//
// A second WebSocket (`/api/term`) carries raw PTY bytes both ways: the backend
// attaches us as another multiplexer subscriber (step 4.1), replays scrollback on
// every (re)connect, and routes our keystrokes to the child. Approve, deny and
// interrupt stay on the dashboard socket as structured actions, so the keystroke
// mapping lives in one place on the desktop (design §11 caveat).

import { Terminal } from "@xterm/xterm";

import type { TermControl } from "../remote/protocol";
import { $ } from "./dom";
import { action, openSocket } from "./net";

const RECONNECT_MS = 1500;

let term: Terminal | null = null;
let termWs: WebSocket | null = null;
let termInstance: string | null = null;
let termOpen = false;
let reconnect: ReturnType<typeof setTimeout> | null = null;
let keyboardOn = false;
let onLink: (text: string) => void = () => {};

/** The quick keys (step R4): what answering the TUI takes, without the keyboard.
 *  The arrows follow the terminal's cursor-key mode, as a real keyboard's would. */
const QUICK_KEYS: Record<string, string | ((t: Terminal | null) => string)> = {
  esc: "\x1b",
  up: (t) => (t?.modes.applicationCursorKeysMode ? "\x1bOA" : "\x1b[A"),
  down: (t) => (t?.modes.applicationCursorKeysMode ? "\x1bOB" : "\x1b[B"),
  tab: "\t",
  backtab: "\x1b[Z",
  enter: "\r",
  "1": "1",
  "2": "2",
  "3": "3",
  "4": "4",
};

function sendRaw(data: string): void {
  if (termWs && termWs.readyState === WebSocket.OPEN) {
    termWs.send(new TextEncoder().encode(data));
  }
}

function ensureTerm(): Terminal {
  if (term) return term;
  const created = new Terminal({
    fontFamily: 'ui-monospace, "JetBrains Mono", "Cascadia Code", Menlo, Consolas, monospace',
    fontSize: 13,
    cursorBlink: true,
    disableStdin: true,
    scrollback: 5000,
    theme: { background: "#000000", foreground: "#d7dbe0", cursor: "#7daea3" },
  });
  created.open($("term-host"));
  // Raw keyboard: fires only when stdin is enabled (the keyboard toggle) and the
  // terminal has focus. Keystrokes go up as raw bytes — nothing is mapped here.
  created.onData(sendRaw);
  term = created;
  return created;
}

function setMessage(text: string): void {
  const msg = $("term-msg");
  msg.textContent = text;
  msg.classList.toggle("hidden", !text);
  // The message takes the terminal's place, so an instance that isn't running
  // shows a clear note instead of an empty black box.
  $("term-wrap").classList.toggle("hidden", !!text);
}

function setConn(text: string): void {
  onLink(text);
}

function setKeyboard(on: boolean): void {
  keyboardOn = on;
  if (term) {
    term.options.disableStdin = !on;
    if (on) term.focus();
  }
  const btn = $("kbBtn");
  btn.classList.toggle("on", on);
  btn.textContent = on ? "keyboard ✓" : "keyboard";
}

// Render at the source terminal's dimensions, then zoom to the phone's width so the
// whole TUI is visible without reflowing it (the phone never resizes the PTY, so it
// can't shrink the desktop console — design §11 smallest-client caveat).
function fit(cols: number, rows: number): void {
  if (!term) return;
  term.resize(cols, rows);
  requestAnimationFrame(() => {
    const screen = $("term-overlay").querySelector<HTMLElement>(".xterm-screen");
    const natural = screen?.offsetWidth || cols * 9;
    const host = $("term-host");
    host.style.width = natural + "px";
    host.style.zoom = Math.min(1, $("term-wrap").clientWidth / natural).toFixed(4);
  });
}

function control(data: string): void {
  let msg: TermControl;
  try {
    msg = JSON.parse(data) as TermControl;
  } catch {
    return;
  }
  if (msg.type === "notrunning") {
    // We keep reconnecting, so it attaches by itself once the instance is started
    // (from its card's "start", or on the desktop).
    setMessage("Session not running — it will appear here once started.");
  } else if (msg.type === "size") {
    // A size can arrive between chunks of output (a resize during the replayed
    // scrollback, or live). xterm parses what it is given a little later, so resize
    // from the write queue: after everything received before this, and before
    // anything after.
    const { cols, rows } = msg;
    term?.write("", () => fit(cols, rows));
  }
}

function connect(): void {
  if (!termOpen || !termInstance) return;
  const ws = openSocket("/api/term", { instance: termInstance });
  ws.binaryType = "arraybuffer";
  termWs = ws;
  setConn("connecting…");
  ws.onopen = () => {
    setConn("● live");
    setMessage("");
    term?.reset();
  };
  ws.onmessage = (ev) => {
    if (typeof ev.data === "string") control(ev.data);
    else term?.write(new Uint8Array(ev.data as ArrayBuffer));
  };
  ws.onerror = () => ws.close();
  ws.onclose = () => {
    if (termWs !== ws) return; // superseded by a newer connection
    termWs = null;
    if (!termOpen) return;
    setConn("○ reconnecting…");
    // The backend replays the scrollback ring on reattach, so a dropped link
    // recovers the full view (the reset in onopen keeps it from stacking).
    reconnect = setTimeout(connect, RECONNECT_MS);
  };
}

/** Show the live terminal of an instance in the console overlay. */
export function showMirror(id: string): void {
  if (termOpen && termInstance === id) return;
  hideMirror();
  termInstance = id;
  termOpen = true;
  setMessage("");
  setKeyboard(false);
  ensureTerm().reset();
  connect();
}

/** Disconnect the terminal (the overlay closed, or switched to the transcript). */
export function hideMirror(): void {
  termOpen = false;
  if (reconnect) {
    clearTimeout(reconnect);
    reconnect = null;
  }
  if (termWs) {
    const ws = termWs;
    termWs = null;
    ws.close();
  }
  setKeyboard(false);
}

/** Wire the terminal's controls; `link` shows its connection state. */
export function initMirror(link: (text: string) => void): void {
  onLink = link;
  $("kbBtn").onclick = () => setKeyboard(!keyboardOn);
  for (const type of ["approve", "deny", "interrupt"] as const) {
    $(`term-${type}`).onclick = () => {
      if (termInstance) action({ type, instanceId: termInstance });
    };
  }
  for (const button of $("term-keys").querySelectorAll<HTMLButtonElement>("button[data-key]")) {
    // Keep the focus (and the on-screen keyboard, if raw typing is on) where it is.
    button.addEventListener("pointerdown", (e) => e.preventDefault());
    button.onclick = () => {
      const key = QUICK_KEYS[button.dataset.key ?? ""];
      if (key !== undefined) sendRaw(typeof key === "function" ? key(term) : key);
    };
  }
}
