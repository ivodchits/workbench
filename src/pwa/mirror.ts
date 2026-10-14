// The mirrored live console (step 4.5, design §11 Phase B).
//
// A second WebSocket (`/api/term`) carries raw PTY bytes both ways: the backend
// attaches us as another multiplexer subscriber (step 4.1), replays scrollback on
// every (re)connect, and routes our keystrokes to the child. Approve, deny and
// interrupt stay on the dashboard socket as structured actions, so the keystroke
// mapping lives in one place on the desktop (design §11 caveat).

import { Terminal } from "@xterm/xterm";

import type { TermControl } from "../remote/protocol";
import { instance } from "./dashboard";
import { $ } from "./dom";
import { action, socketUrl } from "./net";

const RECONNECT_MS = 1500;

let term: Terminal | null = null;
let termWs: WebSocket | null = null;
let termInstance: string | null = null;
let termOpen = false;
let reconnect: ReturnType<typeof setTimeout> | null = null;
let keyboardOn = false;

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
  created.onData((d) => {
    if (termWs && termWs.readyState === WebSocket.OPEN) {
      termWs.send(new TextEncoder().encode(d));
    }
  });
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
  $("term-conn").textContent = text;
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
  const ws = new WebSocket(socketUrl("/api/term", { instance: termInstance }));
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

/** Show the live console of an instance. */
export function openTerminal(id: string): void {
  termInstance = id;
  termOpen = true;
  $("term-title").textContent = instance(id)?.title || "console";
  $("term-overlay").classList.remove("hidden");
  setMessage("");
  setKeyboard(false);
  ensureTerm().reset();
  connect();
}

function closeTerminal(): void {
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
  $("term-overlay").classList.add("hidden");
  setKeyboard(false);
}

export function initMirror(): void {
  $("term-close").onclick = closeTerminal;
  $("kbBtn").onclick = () => setKeyboard(!keyboardOn);
  for (const type of ["approve", "deny", "interrupt"] as const) {
    $(`term-${type}`).onclick = () => {
      if (termInstance) action({ type, instanceId: termInstance });
    };
  }
}
