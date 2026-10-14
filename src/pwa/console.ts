// The console overlay: one session, opened from its card. It opens on the
// transcript (step R4) — reading and replying like a chat — and a toggle in its
// header switches to the mirrored live terminal (step 4.5) for anything the
// transcript can't do. An SSH project's transcript is on the other machine, so it
// only has the terminal.

import type { RemoteInstance } from "../remote/protocol";
import { instance } from "./dashboard";
import { $ } from "./dom";
import { hideMirror, initMirror, showMirror } from "./mirror";
import { hideTranscript, initTranscript, showTranscript, updateTranscript } from "./transcript";

type View = "transcript" | "terminal";

let openId: string | null = null;
let view: View = "transcript";
/** The view last chosen per instance while this page is open. */
const chosen = new Map<string, View>();

function canTranscript(it: RemoteInstance | undefined): boolean {
  return !it?.remote;
}

function link(of: View): (text: string) => void {
  return (text) => {
    if (openId && view === of) setConn(text);
  };
}

function setConn(text: string): void {
  const conn = $("term-conn");
  conn.textContent = text;
  conn.classList.toggle("live", text.startsWith("●"));
}

function setView(next: View): void {
  if (!openId) return;
  const it = instance(openId);
  if (!canTranscript(it)) next = "terminal";
  view = next;
  chosen.set(openId, next);
  const transcript = next === "transcript";
  $("tx-view").classList.toggle("hidden", !transcript);
  $("tx-dock").classList.toggle("hidden", !transcript);
  $("term-view").classList.toggle("hidden", transcript);
  const toggle = $("viewBtn");
  toggle.textContent = transcript ? "terminal" : "transcript";
  toggle.classList.toggle("hidden", !canTranscript(it));
  setConn("");
  if (transcript) {
    hideMirror();
    showTranscript(openId, it);
  } else {
    // The transcript keeps following underneath, so coming back is instant.
    showMirror(openId);
  }
}

/** Open an instance's console, on the view it was last left on (the transcript
 *  the first time). */
export function openConsole(id: string): void {
  if (openId !== id) closeConsole();
  openId = id;
  $("term-title").textContent = instance(id)?.title || "console";
  $("term-overlay").classList.remove("hidden");
  setView(chosen.get(id) ?? "transcript");
}

function closeConsole(): void {
  if (!openId) return;
  openId = null;
  hideMirror();
  hideTranscript();
  $("term-overlay").classList.add("hidden");
}

/** A new snapshot: keep the open console's title and status current. */
export function updateConsole(): void {
  if (!openId) return;
  const it = instance(openId);
  if (it) $("term-title").textContent = it.title || "console";
  updateTranscript(it);
}

export function initConsole(): void {
  initMirror(link("terminal"));
  initTranscript(link("transcript"), () => setView("terminal"));
  $("term-close").onclick = closeConsole;
  $("viewBtn").onclick = () => setView(view === "transcript" ? "terminal" : "transcript");
}
