// Duck's app, before the desktop's page (assistant plan R4, H5): the one page
// the APK carries. It keeps Workbench's address, opens the desktop's own page
// there when it answers (the phone page, `src/pwa/`, with the app's plugin), and
// otherwise stays: the phone's own recognizer and the fast path still set
// timers and alarms, work the flashlight and pause the music.
//
// The address is the Funnel one (`https://<pc>.<tailnet>.ts.net`). With
// Tailscale on, the same name resolves to the tailnet address (MagicDNS), so
// the phone goes the short way without a second address.

import { fastPath } from "../../src/pwa/fastPath";
import * as app from "../../src/pwa/native";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

function show(id: "setup" | "checking" | "offline"): void {
  for (const s of ["setup", "checking", "offline"]) $(s).hidden = s !== id;
}

/** Workbench answers at `address` within a few seconds. */
async function reachable(address: string): Promise<boolean> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 4000);
  try {
    // Another origin's answer can't be read, only that it came.
    await fetch(`${address}/manifest.webmanifest`, { mode: "no-cors", cache: "no-store", signal: ctl.signal });
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(t);
  }
}

async function start(): Promise<void> {
  const address = await app.savedAddress();
  if (!address) {
    show("setup");
    return;
  }
  show("checking");
  if (await reachable(address)) {
    // What opened the app waits in the app for the desktop's page to take it.
    location.replace(`${address}/`);
    return;
  }
  show("offline");
}

const note = (t: string) => ($("note").textContent = t);

async function run(text: string): Promise<void> {
  const c = fastPath(text);
  if (!c) {
    note(`“${text}”: that needs Workbench. Without it, only timers, alarms, the flashlight and play / pause work.`);
    return;
  }
  try {
    await app.runTool(c.tool, c.input);
    note(c.said);
  } catch (e) {
    note(`Didn't work: ${e instanceof Error ? e.message : String(e)}`);
  }
}

async function speak(): Promise<void> {
  note("listening…");
  try {
    const text = await app.recognize();
    if (text) await run(text);
    else note("Didn't hear anything.");
  } catch (e) {
    note(`Didn't hear that: ${e instanceof Error ? e.message : String(e)}`);
  }
}

$("save").onclick = () => {
  const address = app.cleanAddress($<HTMLInputElement>("address").value);
  if (!address) {
    $("setup-msg").textContent = "That's not it: it's an https address ending in .ts.net.";
    return;
  }
  void app.saveAddress(address).then(start);
};
$("speak").onclick = () => void speak();
$("send").onclick = () => {
  const box = $<HTMLInputElement>("say");
  if (box.value.trim()) void run(box.value);
  box.value = "";
};
$("retry").onclick = () => void start();
$("change").onclick = () => {
  void app.savedAddress().then((a) => ($<HTMLInputElement>("address").value = a ?? ""));
  show("setup");
};

void app.onLaunch((l) => {
  if ($("offline").hidden) return;
  if (l.kind === "assist" || l.kind === "listen") void speak();
  else if (l.kind === "talk") note("Conversation mode needs Workbench.");
});
void start();
