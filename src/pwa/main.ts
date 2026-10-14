// Workbench Remote — the phone's dashboard (step 4.4, design §11), built by
// `vite.pwa.config.js` into the one page the desktop app serves (step R1).
//
// Plain TypeScript and DOM, no framework: the page stays small, and it can import
// the same framework-free modules the desktop uses.
//
// Three views: pairing (no token), waiting (a token the desktop has not allowed yet,
// step R2), and the app.

import "@xterm/xterm/css/xterm.css";
import "./style.css";

import { initConsole, openConsole, updateConsole } from "./console";
import { initDashboard } from "./dashboard";
import { $ } from "./dom";
import { checkAccess, connect, forget, isPaired, pair } from "./net";
import { initNewSession, openNewSession } from "./newSession";

/** How often the waiting view asks whether the desktop has decided. */
const WAIT_POLL_MS = 2000;
/** sessionStorage key carrying a pairing-view message across a reload. */
const NOTE_KEY = "wb-remote-note";

let everConnected = false;
let waitTimer: ReturnType<typeof setTimeout> | null = null;

function setConn(live: boolean): void {
  if (live) everConnected = true;
  const conn = $("conn");
  conn.textContent = live ? "● live" : "○ offline";
  conn.className = live ? "live" : "off";
  // The §11 "just shows offline" state: a clear banner once the desktop is lost.
  $("offline").classList.toggle("hidden", live || !everConnected);
}

function show(view: "pair" | "waiting" | "app"): void {
  for (const id of ["pair", "waiting", "app"]) $(id).classList.toggle("hidden", id !== view);
}

function setPairMsg(text: string, error = false): void {
  const msg = $("pair-msg");
  msg.textContent = text;
  msg.classList.toggle("err", error);
}

/** Back to the pairing view, the token dropped, with a word on why. */
function showPairing(note = ""): void {
  if (waitTimer) clearTimeout(waitTimer);
  waitTimer = null;
  forget();
  show("pair");
  setPairMsg(note, note !== "");
}

/** The app was running when the desktop stopped taking this device: start over
 *  from a clean page. */
function lostAccess(): void {
  try {
    sessionStorage.setItem(NOTE_KEY, "1");
  } catch {
    // no storage: the reload just won't say why
  }
  location.reload();
}

function showApp(): void {
  show("app");
  const dashboard = initDashboard({ console: openConsole, newSession: openNewSession });
  const newSession = initNewSession(openConsole);
  connect({
    live: setConn,
    snapshot: (snap) => {
      dashboard(snap);
      newSession(snap);
      updateConsole();
    },
    refused: lostAccess,
  });
}

/** Paired; wait for the desktop's yes or no. */
function showWaiting(): void {
  show("waiting");
  const poll = async () => {
    waitTimer = null;
    const access = await checkAccess();
    if ($("waiting").classList.contains("hidden")) return; // cancelled meanwhile
    if (access === "ok") {
      showApp();
      return;
    }
    if (access === "refused") {
      showPairing("Workbench didn’t allow this device. Pair again to retry.");
      return;
    }
    $("waiting-msg").textContent =
      access === "unreachable" ? "Can’t reach Workbench — still waiting…" : "Waiting for approval…";
    waitTimer = setTimeout(() => void poll(), WAIT_POLL_MS);
  };
  void poll();
}

async function submitPairing(): Promise<void> {
  const code = $<HTMLInputElement>("code").value.trim().toUpperCase();
  const name = $<HTMLInputElement>("name").value.trim() || "device";
  const btn = $<HTMLButtonElement>("pairBtn");
  btn.disabled = true;
  setPairMsg("");
  try {
    const res = await pair(code, name);
    if (res.ok) {
      $<HTMLInputElement>("code").value = "";
      showWaiting();
    } else {
      setPairMsg(res.error, true);
    }
  } catch (e) {
    setPairMsg("Could not reach Workbench: " + String(e), true);
  } finally {
    btn.disabled = false;
  }
}

/** Decide the first view for a page that already holds a token. */
async function resume(): Promise<void> {
  let note = false;
  try {
    note = sessionStorage.getItem(NOTE_KEY) !== null;
    sessionStorage.removeItem(NOTE_KEY);
  } catch {
    // no storage
  }
  const access = await checkAccess();
  if (access === "pending") showWaiting();
  else if (access === "refused") {
    showPairing(
      note
        ? "Workbench stopped taking this device (revoked, or unused too long). Pair again."
        : "This device is no longer paired with Workbench. Pair again.",
    );
  } else showApp(); // ok, or unreachable: the app says "offline" and keeps trying
}

$("pairBtn").onclick = () => void submitPairing();
$("code").addEventListener("keydown", (e) => {
  if (e.key === "Enter") void submitPairing();
});
$("waiting-cancel").onclick = () => showPairing();
$("unpair").onclick = () => {
  forget();
  location.reload();
};
initConsole();

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  });
}

if (isPaired()) {
  $("pair").classList.add("hidden"); // no flash of the pairing form while asking
  void resume();
} else show("pair");
