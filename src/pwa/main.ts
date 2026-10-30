// Workbench Remote — the phone's dashboard (step 4.4, design §11), built by
// `vite.pwa.config.js` into the one page the desktop app serves (step R1).
//
// Plain TypeScript and DOM, no framework: the page stays small, and it can import
// the same framework-free modules the desktop uses.
//
// Three views: pairing (no token), waiting (a token the desktop has not allowed yet,
// step R2), and the app. The app opens on Duck when a shortcut or a share asks
// (`?duck=…`, assistant plan R3), or when that's the start view chosen.
//
// A paired phone opens straight on what it kept of the desktop (`store.ts`): the
// last snapshot is drawn before anything is asked over the network, and the
// header says how it stands (`link.ts`) while the link comes up. Only a phone
// the desktop had stopped taking asks first, so it isn't shown stale data.

import "@xterm/xterm/css/xterm.css";
import "./style.css";

import { initConsole, openConsole, updateConsole } from "./console";
import { initDashboard } from "./dashboard";
import { $ } from "./dom";
import { duckOnStart, initDuck, launchDuck, noteDuckThreads, openDuck, takeLaunchThread } from "./duck";
import { takeLaunch } from "./launch";
import { initLink, offerUpdate, setLink } from "./link";
import { inApp, offlinePut } from "./native";
import { checkAccess, connect, forget, isPaired, loadToken, pair } from "./net";
import { initNewSession, openNewSession } from "./newSession";
import { initNotes, openNotes } from "./notes";
import { initPush, takeLaunchInstance } from "./push";
import type { RemoteSnapshot } from "../remote/protocol";
import { load, saver } from "./store";

/** How often the waiting view asks whether the desktop has decided. */
const WAIT_POLL_MS = 2000;
/** sessionStorage key carrying a pairing-view message across a reload. */
const NOTE_KEY = "wb-remote-note";
/** Where the last snapshot is kept. */
const SNAPSHOT_KEY = "snapshot";

let waitTimer: ReturnType<typeof setTimeout> | null = null;
const keepSnapshot = saver(SNAPSHOT_KEY);

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

/** Duck's app opened this page from its cache because the PC didn't answer
 *  (`?offline=1`): say so from the first frame. Dropped from the address, so a
 *  reload asks afresh. */
const openedOffline = new URLSearchParams(location.search).has("offline");
if (openedOffline) {
  const url = new URL(location.href);
  url.searchParams.delete("offline");
  history.replaceState(history.state, "", url.pathname + url.search + url.hash);
}

/** The app, drawn first from what was kept; the link comes up behind it. */
async function showApp(): Promise<void> {
  await initLink();
  if (openedOffline) setLink("offline");
  const kept = await load<RemoteSnapshot>(SNAPSHOT_KEY);
  show("app");
  const dashboard = initDashboard({
    console: (id) => openConsole(id),
    newSession: openNewSession,
    notes: openNotes,
  });
  const newSession = initNewSession(openConsole);
  const notes = initNotes();
  initPush((id) => openConsole(id));
  initDuck({ console: (id) => openConsole(id), refused: lostAccess });
  // Opened by tapping a push about a card Duck waits on (step R2), by an app
  // shortcut or a share (R3), or plainly with Duck as the start view.
  const duckThread = takeLaunchThread();
  const duckLaunch = takeLaunch();
  if (duckThread) openDuck(duckThread);
  else if (duckLaunch) void launchDuck(duckLaunch);
  else if (duckOnStart()) openDuck();
  // Opened by tapping a push (step R6): show that instance once it is known.
  let launch = takeLaunchInstance();
  const draw = (snap: RemoteSnapshot) => {
    dashboard(snap);
    newSession(snap);
    notes.snapshot(snap);
    noteDuckThreads(snap.duckThreads);
    updateConsole();
    if (launch && snap.instances.some((i) => i.id === launch)) {
      openConsole(launch);
      launch = null;
    }
  };
  // What was kept, at once: every card, console and note list opens on it while
  // the desktop is reached.
  if (kept && Array.isArray(kept.instances)) draw(kept);
  connect({
    live: (live) => {
      // Back after a dropped link: the counts may have moved meanwhile.
      if (live) notes.connected();
    },
    snapshot: (snap) => {
      keepSnapshot(snap);
      draw(snap);
    },
    notes: notes.changed,
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
      void showApp();
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

/** Decide the first view for a page that already holds a token: the app, at once,
 *  on what was kept — the dashboard socket finds out if the desktop has stopped
 *  taking this device (`connect`). After such a refusal (the reload `lostAccess`
 *  makes), ask first. */
async function resume(): Promise<void> {
  let note = false;
  try {
    note = sessionStorage.getItem(NOTE_KEY) !== null;
    sessionStorage.removeItem(NOTE_KEY);
  } catch {
    // no storage
  }
  if (!note) {
    await showApp();
    return;
  }
  setLink("connecting");
  const access = await checkAccess();
  if (access === "pending") showWaiting();
  else if (access === "refused") {
    showPairing(
      note
        ? "Workbench stopped taking this device (revoked, or unused too long). Pair again."
        : "This device is no longer paired with Workbench. Pair again.",
    );
  } else void showApp(); // ok, or unreachable: the app says "offline" and keeps trying
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
  // The page opens from the worker's cache: a new one taking over means a newer
  // page is ready, offered as a reload rather than forced mid-typing.
  const hadWorker = navigator.serviceWorker.controller !== null;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (hadWorker) offerUpdate();
  });
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  });
  // In Duck's app: once this page is in the worker's cache, tell the app, so it
  // opens it (offline) when the PC can't be reached (`duck-android/web/loader.ts`).
  if (inApp())
    void navigator.serviceWorker.ready
      .then(() => caches.match("/"))
      .then((hit) => hit && offlinePut("shell", location.origin))
      .catch(() => {});
}

void (async () => {
  // In Duck's app the token is the app's (R4): read it first.
  $("pair").classList.add("hidden");
  await loadToken();
  if (isPaired()) void resume(); // no flash of the pairing form while asking
  else show("pair");
})();
