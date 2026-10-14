// Workbench Remote — the phone's dashboard (step 4.4, design §11), built by
// `vite.pwa.config.js` into the one page the desktop app serves (step R1).
//
// Plain TypeScript and DOM, no framework: the page stays small, and it can import
// the same framework-free modules the desktop uses.

import "@xterm/xterm/css/xterm.css";
import "./style.css";

import { initDashboard } from "./dashboard";
import { $ } from "./dom";
import { initMirror, openTerminal } from "./mirror";
import { connect, forget, isPaired, pair } from "./net";
import { initNewSession, openNewSession } from "./newSession";

let everConnected = false;

function setConn(live: boolean): void {
  if (live) everConnected = true;
  const conn = $("conn");
  conn.textContent = live ? "● live" : "○ offline";
  conn.className = live ? "live" : "off";
  // The §11 "just shows offline" state: a clear banner once the desktop is lost.
  $("offline").classList.toggle("hidden", live || !everConnected);
}

function showApp(): void {
  $("pair").classList.add("hidden");
  $("app").classList.remove("hidden");
  const dashboard = initDashboard({ console: openTerminal, newSession: openNewSession });
  const newSession = initNewSession(openTerminal);
  connect({
    live: setConn,
    snapshot: (snap) => {
      dashboard(snap);
      newSession(snap);
    },
  });
}

async function submitPairing(): Promise<void> {
  const code = $<HTMLInputElement>("code").value.trim().toUpperCase();
  const name = $<HTMLInputElement>("name").value.trim() || "device";
  const btn = $<HTMLButtonElement>("pairBtn");
  btn.disabled = true;
  try {
    if (await pair(code, name)) showApp();
    else alert("Pairing failed — code wrong or expired.");
  } catch (e) {
    alert("Could not reach Workbench: " + e);
  } finally {
    btn.disabled = false;
  }
}

$("pairBtn").onclick = () => void submitPairing();
$("code").addEventListener("keydown", (e) => {
  if (e.key === "Enter") void submitPairing();
});
$("unpair").onclick = () => {
  forget();
  location.reload();
};
initMirror();

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  });
}

if (isPaired()) showApp();
