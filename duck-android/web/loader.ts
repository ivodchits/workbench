// Duck's app, before the desktop's page (assistant plan R4, H5, H7): the one
// page the APK carries. It keeps Workbench's address, opens the desktop's own
// page there when it answers (the phone page, `src/pwa/`, with the app's
// plugin), and otherwise stays and answers itself:
//
// - The fast path first (timers, alarms, the flashlight, play / pause), with no
//   model, through the phone's own recognizer when spoken.
// - Anything else goes to the phone brain (H7, `src/pwa/phoneBrain.ts`): Duck's
//   engine here, on the phone key, with the phone's tools and its own reminders.
//   Its replies are said with the phone's own voice when you spoke. Without a
//   phone key, only the fast path works.
//
// The address is the Funnel one (`https://<pc>.<tailnet>.ts.net`). With
// Tailscale on, the same name resolves to the tailnet address (MagicDNS), so
// the phone goes the short way without a second address.
//
// Once Workbench's page is kept here (its service worker has it; the page says
// so through the app, `offline_put("shell")`), an unreachable PC opens that page
// anyway, marked offline (`?offline=1`): the sessions, Duck's threads and notes
// as they were cached, with what's written there waiting to sync. The page's
// offline strip leads back here (`?brain=1`) for the phone brain. Before the
// page is kept, the phone brain is what an unreachable PC gets, as before.

import { fastPath } from "../../src/pwa/fastPath";
import * as app from "../../src/pwa/native";
import { startPhoneBrain, type PhoneBrain } from "../../src/pwa/phoneBrain";
import type { DuckEvent } from "../../src/assistant/protocol";
import type { StoredMessage } from "../../src/ipc/assistant";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

/** The origin whose page the app has in its cache, as the page reported it. */
async function keptShell(): Promise<string | null> {
  return app.offlineGet("shell").catch(() => null);
}

/** Sent back from the page's offline strip: stay with the phone brain. */
const brainAsked = new URLSearchParams(location.search).has("brain");

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

/** Open Workbench's page; `stay` keeps the phone brain when the PC doesn't
 *  answer (asked for it, or trying again from here). */
async function start(stay = false): Promise<void> {
  const address = await app.savedAddress();
  if (!address) {
    show("setup");
    return;
  }
  const kept = (await keptShell()) === address;
  $("kept").hidden = !kept;
  if (stay && brainAsked && $("offline").hidden) {
    // Straight from the page's strip: it just found the PC unreachable.
    show("offline");
    await openBrain();
    return;
  }
  show("checking");
  if (await reachable(address)) {
    // What opened the app waits in the app for the desktop's page to take it.
    location.replace(`${address}/`);
    return;
  }
  if (kept && !stay) {
    // The cached page, saying it's offline; the phone brain is a tap away there.
    location.replace(`${address}/?offline=1`);
    return;
  }
  show("offline");
  await openBrain();
}

const note = (t: string) => ($("note").textContent = t);

// ── the phone brain ──

let brain: PhoneBrain | null = null;
/** The thread shown. */
let shown: string | null = null;
/** The streaming reply's bubble. */
let live: HTMLElement | null = null;
/** The turn running was spoken: its reply is said. */
let saying = false;

function bubble(cls: string, text: string): HTMLElement {
  const el = document.createElement("div");
  el.className = cls;
  el.textContent = text;
  $("log").append(el);
  el.scrollIntoView({ block: "end" });
  return el;
}

const textOf = (content: unknown): string =>
  Array.isArray(content)
    ? (content as { type?: string; text?: string }[])
        .filter((b) => b.type === "text")
        .map((b) => b.text ?? "")
        .join("\n")
    : typeof content === "string"
      ? content
      : "";

/** A reply as the phone's voice says it: no markdown. */
const sayable = (text: string) =>
  text
    .replace(/```[\s\S]*?```/g, "")
    .replace(/[*_`#>|]/g, "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .trim();

function render(m: StoredMessage): void {
  if (m.role === "notice") {
    const n = m.content as { text?: string };
    if (n.text) bubble("line", n.text);
    return;
  }
  const text = textOf(m.content).trim();
  if (!text) return;
  if (m.role === "user" && (m.source === "phone" || m.source === "phone-voice")) bubble("user", text);
  else if (m.role === "assistant") {
    live?.remove();
    live = null;
    bubble("duck", text);
    if (saying) void app.speak(sayable(text)).catch(() => {});
  }
}

function onEvent(e: DuckEvent): void {
  switch (e.type) {
    case "message":
      if (e.message.threadId === shown) render(e.message);
      return;
    case "delta":
      if (e.threadId !== shown) return;
      live ??= bubble("duck", "");
      live.textContent += e.text;
      live.scrollIntoView({ block: "end" });
      return;
    case "tool":
      if (e.threadId === shown && e.phase === "start" && e.name !== "tool_search_tool_regex") note(`using ${e.name.replace(/^phone_/, "the phone's ").replace(/_/g, " ")}…`);
      return;
    case "turnState":
      if (e.threadId !== shown) return;
      note(e.state === "thinking" ? "thinking…" : e.state === "waiting" ? "waiting for your answer" : "");
      if (e.state === "idle" || e.state === "waiting") void spendLine();
      return;
    case "confirm": {
      const r = e.request;
      if (r.threadId !== shown) return;
      const card = bubble("card", r.summary ?? `Duck wants to use ${r.name}.`);
      if (saying) void app.speak(sayable(card.textContent ?? "")).catch(() => {});
      for (const [label, allow] of [["Allow", true], ["Deny", false]] as const) {
        const b = document.createElement("button");
        b.type = "button";
        b.textContent = label;
        b.onclick = () => {
          card.querySelectorAll("button").forEach((x) => (x.disabled = true));
          void brain?.engine.confirm(r.threadId, r.toolUseId, allow).catch((err: unknown) => note(app.reason(err)));
        };
        card.append(document.createElement("br"), b);
      }
      return;
    }
    case "error":
      note(e.message);
      return;
  }
}

async function showThread(id: string | null): Promise<void> {
  shown = id;
  $("log").replaceChildren();
  live = null;
  if (!brain || !id) return;
  for (const m of await brain.messages(id)) render(m);
}

async function spendLine(): Promise<void> {
  const key = await app.phoneKey().catch(() => ({ set: false, hint: null }));
  const line = $("brain-line");
  if (!key.set) {
    line.innerHTML = "<strong>Workbench can't be reached.</strong> Timers, alarms, the flashlight and play / pause still work; for the rest, give Duck a phone key below.";
    $("key-state").textContent = "No phone key yet.";
    return;
  }
  const s = await app.phoneSpend().catch(() => null);
  line.innerHTML = "<strong>Workbench can't be reached.</strong> Duck is answering on the phone.";
  if (s) line.append(` $${s.usd.toFixed(2)} of $${s.cap.toFixed(2)} this month.`);
  $("key-state").textContent = `The phone key ends in …${key.hint ?? ""}.`;
  if (s) $<HTMLInputElement>("cap").value = String(s.cap);
}

/** Start the phone brain, when there's a key. */
async function openBrain(): Promise<void> {
  await spendLine();
  if (brain || !(await app.phoneKey().catch(() => ({ set: false }))).set) return;
  try {
    const info = await app.hostInfo();
    brain = await startPhoneBrain({
      fetch: app.apiFetch,
      get: app.offlineGet,
      put: app.offlinePut,
      runTool: app.runTool,
      tools: info.tools,
      arm: (alarms) => app.armReminders(alarms, "phone"),
      spend: app.phoneSpend,
    });
    brain.engine.onEvent(onEvent);
    await showThread(brain.current());
  } catch (e) {
    note(`The phone brain didn't start: ${app.reason(e)}`);
  }
}

async function run(text: string, voice: boolean): Promise<void> {
  const c = fastPath(text);
  if (c) {
    try {
      await app.runTool(c.tool, c.input);
      note(c.said);
      if (voice) void app.speak(c.said).catch(() => {});
    } catch (e) {
      note(`Didn't work: ${app.reason(e)}`);
    }
    return;
  }
  if (!brain) {
    note(`“${text}”: that needs Workbench, or a phone key for Duck to answer here.`);
    return;
  }
  saying = voice;
  void app.speakStop().catch(() => {});
  try {
    const id = await brain.send(text, voice);
    if (id !== shown) await showThread(id);
  } catch (e) {
    note(app.reason(e));
  }
}

async function speak(): Promise<void> {
  void app.speakStop().catch(() => {});
  note("listening…");
  try {
    const text = await app.recognize();
    if (text) await run(text, true);
    else note("Didn't hear anything.");
  } catch (e) {
    note(`Didn't hear that: ${app.reason(e)}`);
  }
}

$("save").onclick = () => {
  const address = app.cleanAddress($<HTMLInputElement>("address").value);
  if (!address) {
    $("setup-msg").textContent = "That's not it: it's an https address ending in .ts.net.";
    return;
  }
  void app.saveAddress(address).then(() => start());
};
$("speak").onclick = () => void speak();
$("send").onclick = () => {
  const box = $<HTMLInputElement>("say");
  if (box.value.trim()) void run(box.value.trim(), false);
  box.value = "";
};
$("say").onkeydown = (e) => {
  if (e.key === "Enter") $("send").click();
};
$("retry").onclick = () => void start(true);
$("kept").onclick = () => {
  void app.savedAddress().then((a) => a && location.replace(`${a}/?offline=1`));
};
$("fresh").onclick = () => {
  brain?.fresh();
  void showThread(null);
  note("The next message starts a new conversation.");
};
$("change").onclick = () => {
  void app.savedAddress().then((a) => ($<HTMLInputElement>("address").value = a ?? ""));
  show("setup");
};
$("key-save").onclick = () => {
  const box = $<HTMLInputElement>("key");
  void app
    .setPhoneKey(box.value.trim())
    .then(() => {
      box.value = "";
      return openBrain();
    })
    .catch((e: unknown) => ($("key-state").textContent = app.reason(e)));
};
$("key-forget").onclick = () => {
  void app.setPhoneKey(null).then(() => {
    brain = null;
    return spendLine();
  });
};
$("cap-save").onclick = () => {
  const cap = Number($<HTMLInputElement>("cap").value);
  if (!(cap >= 0)) return;
  void app.setAppSettings({ phoneCap: cap }).then(spendLine);
};

void app.onLaunch((l) => {
  if ($("offline").hidden) return;
  if (l.kind === "assist" || l.kind === "listen") void speak();
  else if (l.kind === "talk") note("Conversation mode needs Workbench; the Speak button works here.");
});
void start(brainAsked);
