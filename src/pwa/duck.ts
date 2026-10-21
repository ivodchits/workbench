// Duck on the phone (step R2): the chat over `/api/assistant` (R1), with the mic,
// spoken replies and the ASCII duck.
//
// - The overlay opens from the dashboard's "duck" button, or from a push about a
//   card (`#duck=<thread>`, or the service worker's `open-duck`).
// - The socket is open only while the overlay is on screen. So with the phone
//   away, the desktop counts no phone, and a card that comes then is pushed.
// - The chat is drawn like the drawer's: the desktop's `toItems` and markdown,
//   with tool chips, cards to allow or deny, task cards and the spend line.
// - The mic: tap to start and tap again to send, or hold and let go. The clip goes
//   to the desktop's model (`/api/assistant/audio`), and the text goes to Duck as
//   spoken (names fixed, the reply written to be heard), or into the composer
//   when "send at once" is off. The page must be https (the Funnel address);
//   otherwise the mic says why it's off.
// - Spoken replies (`duckSpeech.ts`): with the desktop's voice, or the phone's own.
//   By default only replies to what you said are spoken.
// - The duck spins while Duck works, listens while you talk, and talks with the
//   loudness of what's playing. Tapping it hushes the reply.
// - Trust: the header's button pauses it, the kill switch. Resuming, rules and
//   settings stay on the desktop. The decisions are a read-only list.
// - "talk" (step V4 part 3): conversation mode. The mic streams to the desktop
//   (`converse.ts`), which hears the turns and says them back (`conv.turn`); each
//   goes to Duck as a provisional message, kept on `final` and dropped if you went
//   on talking. Replies are spoken; talking over Duck's voice stops it (the
//   desktop's `conv.cut`), so the page says when that voice is playing. Off by
//   "talk" again, by "that's all for now", after the desktop's quiet minutes, or
//   when the page goes away (the screen off): the socket closes then.

import { langOf, Sentences } from "../assistant/speakable";
import { USER_SOURCES, type ConfirmRequest, type DecisionRow, type Notice, type TaskView, type TurnState } from "../assistant/protocol";
import type { DuckMode } from "../panels/Assistant/duck3d";
import { startDuckCanvas, type DuckLook } from "../panels/Assistant/duckCanvas";
import { lineDiff, oneLine, readableInput, sessionLink, toItems, type Item } from "../panels/Assistant/view";
import { renderMarkdown } from "../panels/Editor/markdown";
import type { RemoteConvFrame, RemoteConvMessage, RemoteDuckFrame, RemoteDuckMessage } from "../remote/protocol";
import { formatAgo } from "../util/format";
import { $, el } from "./dom";
import { apply, emptyView, userText, type DuckView } from "./duckStore";
import { browserOut, fetchPart, playbackLevel, unlock } from "./duckSpeech";
import { chime, stream, type Streaming } from "./converse";
import { SpeechQueue } from "./speechQueue";
import { micAvailable, record, type Recording } from "./mic";
import { api, ApiError, checkAccess, openSocket } from "./net";

const RECONNECT_MS = 2000;
const STICK_PX = 48;
/** Held this long, the mic sends on release; a shorter press toggles. */
const HOLD_MS = 350;
const PREFS_KEY = "wb-duck-prefs";
const THREAD_KEY = "wb-duck-thread";

interface Prefs {
  /** Which replies are spoken: to what you said, all, or none. */
  speak: "voice" | "always" | "off";
  /** The desktop's voice, or the phone's own. */
  voice: "desktop" | "phone";
  /** A dictated message goes at once; off: into the composer. */
  sendNow: boolean;
  /** Show the duck. */
  duck: boolean;
}

const DEFAULT_PREFS: Prefs = { speak: "voice", voice: "desktop", sendNow: true, duck: true };
const LOOK: DuckLook = { ink: "color", chars: "classic", cols: 56, fps: 20 };

const STATE_LABEL: Record<Exclude<TurnState, "idle">, string> = {
  thinking: "thinking…",
  streaming: "replying…",
  tool: "running a tool…",
  waiting: "waiting for your answer",
};

const AVATAR_MODE: Record<TurnState, DuckMode> = {
  idle: "idle",
  thinking: "thinking",
  tool: "thinking",
  streaming: "talking",
  waiting: "listening",
};

const SOURCE_LABEL: Record<string, string> = {
  desktop: "from the desktop",
  voice: "spoken at the desktop",
  "phone-voice": "spoken",
};

const TASK_STATE: Record<string, string> = {
  queued: "waiting for a free worker",
  running: "working",
  done: "done",
  blocked: "blocked",
  needs_decision: "needs a decision",
  failed: "failed",
  closed: "closed",
};

const usd = (n: number) => (n < 1 ? `$${n.toFixed(3)}` : `$${n.toFixed(2)}`);

function loadPrefs(): Prefs {
  try {
    return { ...DEFAULT_PREFS, ...(JSON.parse(localStorage.getItem(PREFS_KEY) ?? "{}") as Partial<Prefs>) };
  } catch {
    return DEFAULT_PREFS;
  }
}

function store(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // no storage: it's forgotten
  }
}

let prefs = loadPrefs();
let view: DuckView = emptyView();
let adopting = false;
let shown = false;
let panel: "chat" | "threads" | "decisions" | "settings" = "chat";
let ws: WebSocket | null = null;
let retry: ReturnType<typeof setTimeout> | null = null;
/** The thread a push or a link asked for, opened once the list is in. */
let wantThread: string | null = null;
let stopDuck: (() => void) | null = null;
let stuck = true;
let deps: { console: (instanceId: string) => void; refused: () => void } = { console: () => {}, refused: () => {} };

// Speech: the queue, and the phone's own voice's reply.
const queue = new SpeechQueue(browserOut, () => paintVoice());
/** Hushed: nothing more is spoken until the next send. */
let hushed = false;
/** Messages sent for the phone's own voice, waiting to be seen stored. */
const nativeWanted: string[] = [];
let native: { threadId: string; cut: Sentences; provisional?: boolean } | null = null;

// The mic.
let recording: Recording | null = null;
let starting: Promise<void> | null = null;
let downAt = 0;
let ignoreUp = false;
let voiceNote = "";
/** The composer's text came from the mic. */
let dictated = false;

// Conversation mode (V4 part 3).
let talk: Streaming | null = null;
let talkStarting = false;
/** The desktop's state for it (`preparing`, `listening`, `hearing`, `grace`). */
let talkState = "";
let talkHeld = false;
/** The desktop's newest run heard, and the last over: frames of runs up to that
 *  one come late and are ignored. */
let talkRun = 0;
let talkEnded = 0;
/** Turns sent provisionally, by id, with their thread. */
const talkSent = new Map<number, string>();
/** What the desktop was last told about Duck's voice here. */
let playingSaid = false;
/** The thread whose provisional turn the phone's own voice will answer. */
let nativeProvisional: string | null = null;
/** The thread whose reply the phone's own voice spoke last, and the thread Duck
 *  moved the conversation into from it (A7), whose next reply it speaks too. */
let nativeLast: string | null = null;
let nativeFollow: string | null = null;

// ── the socket ──────────────────────────────────────────────────────────────

function post(msg: RemoteDuckMessage | RemoteConvMessage): void {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function connect(): void {
  if (ws || !shown || document.hidden) return;
  const socket = openSocket("/api/assistant");
  ws = socket;
  let opened = false;
  paintConn("connecting…");
  socket.onopen = () => {
    opened = true;
    paintConn("● live", "live");
    post({ type: "sync" });
    if (view.current) post({ type: "thread.open", threadId: view.current });
  };
  socket.onclose = () => {
    if (ws !== socket) return;
    ws = null;
    paintConn("○ offline", "off");
    if (talk || talkStarting) endTalk("The connection dropped, so conversation mode is off.");
    if (!shown || document.hidden) return;
    if (opened) {
      retry = setTimeout(connect, RECONNECT_MS);
      return;
    }
    void checkAccess().then((access) => {
      if (access === "refused" || access === "pending") deps.refused();
      else retry = setTimeout(connect, RECONNECT_MS);
    });
  };
  socket.onerror = () => socket.close();
  socket.onmessage = (ev) => {
    let f: RemoteDuckFrame;
    try {
      f = JSON.parse(ev.data as string) as RemoteDuckFrame;
    } catch {
      return;
    }
    onFrame(f);
  };
}

function disconnect(): void {
  if (retry) clearTimeout(retry);
  retry = null;
  const socket = ws;
  ws = null;
  socket?.close();
}

function onFrame(f: RemoteDuckFrame): void {
  if (f.type.startsWith("conv.")) {
    onConv(f as RemoteConvFrame);
    return;
  }
  if (f.type === "tts") {
    // Duck's news (V5) plays only where this phone's speaking isn't off.
    const news = f.reply.startsWith("news");
    if (!hushed && !(news && prefs.speak === "off")) queue.add({ audio: fetchPart(f.id), text: f.text, lang: langOf(f.text) });
    return;
  }
  if (f.type === "ttsEnd") return;
  if (f.type === "ttsCut") {
    queue.stop();
    return;
  }
  const before = view;
  const r = apply(view, f, adopting);
  view = r.view;
  if (r.adopted) {
    adopting = false;
    store(THREAD_KEY, view.current);
  }
  if (r.fx.open) openThread(r.fx.open);
  if (r.fx.refetch && view.current) post({ type: "thread.open", threadId: view.current });
  if (f.type === "goThread" && f.surface === "phone" && view.threads.some((t) => t.id === f.threadId)) {
    // Duck moved the conversation (A7): the next turn goes there.
    if (nativeLast === f.from) nativeFollow = f.threadId;
    openThread(f.threadId);
  }
  if (f.type === "threads" && !before.synced) {
    const saved = (() => {
      try {
        return localStorage.getItem(THREAD_KEY);
      } catch {
        return null;
      }
    })();
    const pick = [wantThread, view.current, saved].find((id) => id && view.threads.some((t) => t.id === id));
    wantThread = null;
    openThread(pick ?? view.threads[0]?.id ?? null);
  } else if (f.type === "threads" && wantThread && view.threads.some((t) => t.id === wantThread)) {
    openThread(wantThread);
    wantThread = null;
  }
  speakNative(f);
  paint(f.type, before);
}

/** The phone's own voice: cut the reply to a message sent for it into sentences. */
function speakNative(f: RemoteDuckFrame): void {
  if (f.type === "provisional" && f.threadId === nativeProvisional) {
    // A turn of conversation mode: its reply is said as it streams.
    nativeProvisional = null;
    nativeLast = f.threadId;
    native = { threadId: f.threadId, cut: new Sentences(), provisional: true };
  } else if (f.type === "withdrawn" && native?.threadId === f.threadId && native.provisional) {
    native = null;
    queue.stop();
  } else if (f.type === "message" && f.message.role === "user" && native?.provisional && native.threadId === f.message.threadId) {
    // The provisional turn stood: its reply carries on.
    native.provisional = false;
  } else if (f.type === "message" && f.message.role === "user" && USER_SOURCES.has(f.message.source)) {
    if (native?.threadId === f.message.threadId) native = null;
    const phone = f.message.source.startsWith("phone");
    const i = phone ? nativeWanted.indexOf(userText(f.message).trim()) : -1;
    const moved = phone && nativeFollow === f.message.threadId;
    if (nativeFollow === f.message.threadId) nativeFollow = null;
    if (i >= 0) nativeWanted.splice(i, 1);
    if (i >= 0 || moved) {
      nativeLast = f.message.threadId;
      native = { threadId: f.message.threadId, cut: new Sentences() };
    } else if (nativeLast === f.message.threadId) nativeLast = null;
  } else if (f.type === "tool" && f.phase === "start" && native?.threadId === f.threadId) {
    for (const s of native.cut.end()) if (!hushed) queue.add({ audio: Promise.resolve(null), text: s, lang: langOf(s) });
  } else if (f.type === "delta" && native?.threadId === f.threadId) {
    for (const s of native.cut.push(f.text)) if (!hushed) queue.add({ audio: Promise.resolve(null), text: s, lang: langOf(s) });
  } else if (f.type === "turnState" && native?.threadId === f.threadId && (f.state === "idle" || f.state === "waiting")) {
    for (const s of native.cut.end()) if (!hushed) queue.add({ audio: Promise.resolve(null), text: s, lang: langOf(s) });
    native = null;
  }
}

// ── actions ─────────────────────────────────────────────────────────────────

function openThread(id: string | null): void {
  view = { ...view, current: id };
  store(THREAD_KEY, id);
  stuck = true;
  if (id) post({ type: "thread.open", threadId: id });
  panel = "chat";
  paint("open");
}

/** Stop the reply being spoken, and what's still coming of it; a read playing
 *  here pauses. */
function hush(): void {
  if (view.reader?.where === "phone" && view.reader.state === "reading") post({ type: "reader", action: "pause" });
  hushed = true;
  native = null;
  queue.stop();
}

/** Send a message. Conversation mode's are spoken whatever the setting, and may
 *  be `provisional`. */
function send(text: string, voice: boolean, talked: { provisional: boolean } | null = null): void {
  const body = text.trim();
  if (!body) return;
  unlock();
  hush();
  hushed = false;
  const speak = !!talked || prefs.speak === "always" || (prefs.speak === "voice" && voice);
  if (speak && prefs.voice === "phone") {
    if (talked?.provisional) nativeProvisional = view.current;
    else nativeWanted.push(body);
  }
  if (view.current === null) adopting = true;
  post({
    type: "send",
    threadId: view.current,
    text: body,
    ...(voice && { voice: true }),
    ...(speak && prefs.voice === "desktop" && { speak: true }),
    ...(talked?.provisional && { provisional: true }),
  });
  stuck = true;
}

function sendComposer(): void {
  const text = $<HTMLTextAreaElement>("duck-text");
  if (!text.value.trim() || ws?.readyState !== WebSocket.OPEN) return;
  send(text.value, dictated);
  text.value = "";
  dictated = false;
  fitComposer();
}

function stopAll(): void {
  hush();
  const id = view.current;
  if (id && (view.states[id] ?? "idle") !== "idle") post({ type: "stop", threadId: id });
  paintVoice();
}

// ── conversation mode (V4 part 3) ───────────────────────────────────────────

async function startTalk(): Promise<void> {
  if (talk || talkStarting) return;
  if (ws?.readyState !== WebSocket.OPEN) {
    setVoiceNote("Not connected to Workbench.");
    return;
  }
  unlock();
  hush();
  hushed = false;
  cancelRecording();
  talkStarting = true;
  talkState = "preparing";
  voiceNote = "";
  paintVoice();
  // The desktop loads its models while the browser asks for the mic.
  post({ type: "conv.start" });
  try {
    const s = await stream((frame) => {
      if (ws?.readyState === WebSocket.OPEN) ws.send(frame);
    });
    if (talkStarting) talk = s;
    else s.stop();
  } catch (e) {
    post({ type: "conv.stop" });
    endTalk(
      e instanceof DOMException && e.name === "NotAllowedError"
        ? "The mic was refused. Allow it for this site in the browser's settings."
        : `The mic didn't start: ${e instanceof Error ? e.message : String(e)}`,
    );
  } finally {
    talkStarting = false;
    paintVoice();
  }
}

/** Conversation mode is over here (`message` says why, if it should). */
function endTalk(message = ""): void {
  talkEnded = Math.max(talkEnded, talkRun);
  talk?.stop();
  talk = null;
  talkStarting = false;
  talkState = "";
  talkHeld = false;
  talkSent.clear();
  playingSaid = false;
  setVoiceNote(message);
}

function stopTalk(): void {
  post({ type: "conv.stop" });
  endTalk();
}

function onConv(f: RemoteConvFrame): void {
  if (!talk && !talkStarting) return;
  if (f.type === "conv.state" || f.type === "conv.turn") {
    if (f.run !== 0 && f.run <= talkEnded) return;
    if (f.run > talkRun) talkRun = f.run;
  }
  switch (f.type) {
    case "conv.state":
      if (f.state === "off" || f.state === "error") {
        endTalk(f.message ?? "");
        return;
      }
      talkState = f.state;
      talkHeld = f.held;
      paintVoice();
      return;
    case "conv.turn":
      routeTalk(f);
      return;
    case "conv.cut":
      hush();
      paintVoice();
      return;
    case "conv.cue":
      chime();
      return;
  }
}

/** A turn the desktop heard: provisional into the open thread when it's free,
 *  else a plain message once it's final. */
function routeTalk(t: Extract<RemoteConvFrame, { type: "conv.turn" }>): void {
  switch (t.phase) {
    case "provisional": {
      const id = view.current;
      if (!id || (view.states[id] ?? "idle") !== "idle") return;
      send(t.text, true, { provisional: true });
      talkSent.set(t.id, id);
      return;
    }
    case "withdrawn": {
      const id = talkSent.get(t.id);
      talkSent.delete(t.id);
      if (id) post({ type: "turn.withdraw", threadId: id });
      return;
    }
    case "final": {
      const id = talkSent.get(t.id);
      talkSent.delete(t.id);
      if (id) post({ type: "turn.commit", threadId: id });
      else send(t.text, true, { provisional: false });
    }
  }
}

function wireTalk(): void {
  const b = $<HTMLButtonElement>("duck-talk");
  if (!micAvailable()) {
    b.classList.add("off");
    b.onclick = () => setVoiceNote("Conversation mode needs the mic, which this page can't have here.");
    return;
  }
  b.onclick = () => {
    if (talk || talkStarting) stopTalk();
    else void startTalk();
  };
}

/** What conversation mode's line says. */
function talkNote(): string {
  const id = view.current;
  const busy = !!id && (view.states[id] ?? "idle") !== "idle";
  if (talkStarting || talkState === "preparing") return "getting the voice ready…";
  if (talkHeld) return "● holding the turn open: say “go on” when you're done";
  if (talkState === "hearing") return "● hearing you";
  if (talkState === "grace") return "● sent; keep talking to add to it";
  if (queue.speaking) return "speaking · talk to interrupt";
  return busy ? "● thinking (listening)" : "● listening · say “that's all for now” to stop";
}

// ── the mic ─────────────────────────────────────────────────────────────────

function setVoiceNote(text: string): void {
  voiceNote = text;
  paintVoice();
}

async function startRecording(): Promise<void> {
  if (talk || talkStarting) stopTalk();
  unlock();
  hush();
  try {
    recording = await record(() => void finishRecording());
    setVoiceNote("listening… tap to send");
  } catch (e) {
    recording = null;
    setVoiceNote(
      e instanceof DOMException && e.name === "NotAllowedError"
        ? "The mic was refused. Allow it for this site in the browser's settings."
        : `The mic didn't start: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

async function finishRecording(): Promise<void> {
  await starting;
  const r = recording;
  recording = null;
  if (!r) return;
  const wav = await r.stop();
  if (!wav) {
    setVoiceNote("Too short to hear.");
    return;
  }
  setVoiceNote("transcribing…");
  try {
    const { text } = await api<{ text: string; ms: number }>("/api/assistant/audio", { raw: wav, type: "audio/wav" });
    if (!text.trim()) {
      setVoiceNote("Nothing was heard.");
      return;
    }
    setVoiceNote("");
    if (prefs.sendNow) send(text, true);
    else {
      const box = $<HTMLTextAreaElement>("duck-text");
      box.value = (box.value.trim() ? `${box.value.trimEnd()} ` : "") + text.trim();
      dictated = true;
      fitComposer();
    }
  } catch (e) {
    setVoiceNote(e instanceof ApiError ? `Couldn't transcribe: ${e.message}` : "Couldn't reach Workbench to transcribe.");
  }
}

function cancelRecording(): void {
  recording?.cancel();
  recording = null;
}

function wireMic(): void {
  const mic = $<HTMLButtonElement>("duck-mic");
  if (!micAvailable()) {
    mic.classList.add("off");
    mic.onclick = () =>
      setVoiceNote(
        isSecureContext
          ? "This browser can't record here."
          : "The mic needs the https (Funnel) address of Workbench; this page isn't secure.",
      );
    return;
  }
  mic.addEventListener("contextmenu", (e) => e.preventDefault());
  mic.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    if (recording || starting) {
      ignoreUp = true;
      void finishRecording();
      return;
    }
    downAt = performance.now();
    starting = startRecording().finally(() => (starting = null));
    paintVoice();
  });
  const up = () => {
    if (ignoreUp) {
      ignoreUp = false;
      return;
    }
    if (performance.now() - downAt > HOLD_MS && (recording || starting)) void finishRecording();
  };
  mic.addEventListener("pointerup", up);
  mic.addEventListener("pointercancel", up);
}

// ── painting ────────────────────────────────────────────────────────────────

function paintConn(text: string, cls = ""): void {
  const c = $("duck-conn");
  c.textContent = text;
  c.className = cls;
}

function scroller(): HTMLElement {
  return $("duck-scroll");
}

function toEnd(): void {
  const s = scroller();
  s.scrollTop = s.scrollHeight;
}

function mode(): DuckMode {
  if (recording || starting || talkState === "hearing") return "listening";
  if (queue.speaking) return "talking";
  const id = view.current;
  return AVATAR_MODE[id ? (view.states[id] ?? "idle") : "idle"];
}

function startAvatar(): void {
  const canvas = $<HTMLCanvasElement>("duck-avatar");
  canvas.classList.toggle("hidden", !prefs.duck);
  if (stopDuck || !prefs.duck || !shown || document.hidden) return;
  stopDuck = startDuckCanvas(canvas, () => ({
    mode: mode(),
    look: LOOK,
    level: recording
      ? () => recording?.level() ?? 0
      : talk && talkState === "hearing"
        ? () => talk?.level() ?? 0
        : queue.speaking && prefs.voice === "desktop"
          ? playbackLevel
          : undefined,
  }));
}

function stopAvatar(): void {
  stopDuck?.();
  stopDuck = null;
}

/** The mic's line and the stop button. */
function paintVoice(): void {
  const line = $("duck-voice");
  const talking = !!(talk || talkStarting);
  const note =
    recording || starting
      ? voiceNote || "listening…"
      : talking
        ? talkNote()
        : voiceNote || (queue.speaking ? "speaking · tap the duck to hush" : "");
  line.textContent = note;
  line.classList.toggle("hidden", !note);
  $("duck-mic").classList.toggle("on", !!(recording || starting));
  $("duck-talk").classList.toggle("on", talking);
  // The desktop stops Duck's voice when you talk over it, so it's told when that
  // voice plays here.
  if (talk && queue.speaking !== playingSaid) {
    playingSaid = queue.speaking;
    post({ type: "conv.playing", on: playingSaid });
  }
  const id = view.current;
  const running = !!id && (view.states[id] ?? "idle") !== "idle";
  $("duck-stop").classList.toggle("hidden", !running && !queue.speaking);
}

let streamFrame = 0;

function paintStream(): void {
  if (streamFrame) return;
  streamFrame = requestAnimationFrame(() => {
    streamFrame = 0;
    const id = view.current;
    const text = id ? (view.streaming[id] ?? "") : "";
    const box = $("duck-stream");
    box.innerHTML = text ? renderMarkdown(text) : "";
    paintStatus();
    if (stuck) toEnd();
  });
}

function paintStatus(): void {
  const id = view.current;
  const state = id ? (view.states[id] ?? "idle") : "idle";
  const streaming = id ? view.streaming[id] : "";
  const s = $("duck-status");
  s.textContent = state !== "idle" && !streaming ? STATE_LABEL[state] : "";
}

/** The reader bar (V3): what's being read, and its buttons. */
function paintReader(): void {
  const r = view.reader;
  $("duck-reader").classList.toggle("hidden", !r);
  if (!r) return;
  $("duck-reader-text").textContent = `${r.state === "reading" ? "♪" : "❚❚"} ${r.title} · ${r.section + 1}/${r.sections}${r.where === "desktop" ? " · on the PC" : ""}`;
  const toggle = document.querySelector<HTMLButtonElement>('#duck-reader [data-reader="toggle"]')!;
  toggle.textContent = r.state === "reading" ? "❚❚" : "▶";
  toggle.setAttribute("aria-label", r.state === "reading" ? "pause" : "go on");
  document.querySelector<HTMLButtonElement>('#duck-reader [data-reader="prev"]')!.disabled = r.section === 0;
  document.querySelector<HTMLButtonElement>('#duck-reader [data-reader="next"]')!.disabled = r.section + 1 >= r.sections;
}

function readerButton(what: string): void {
  const r = view.reader;
  if (!r) return;
  if (what === "stop" || (what === "toggle" && r.state === "reading")) {
    if (r.where === "phone") queue.stop();
    post({ type: "reader", action: what === "stop" ? "stop" : "pause" });
    return;
  }
  // Going on: this phone may play it again.
  unlock();
  hushed = false;
  post({ type: "reader", action: what === "toggle" ? "resume" : what === "next" ? "next" : "prev" });
}

function paint(why: string, before?: DuckView): void {
  if (!shown) return;
  $("duck-thread").textContent = `${view.threads.find((t) => t.id === view.current)?.title || (view.current ? "a thread" : "new thread")} ▾`;
  paintTrust();
  for (const p of ["chat", "threads", "decisions", "settings"] as const) $(`duck-${p}`).classList.toggle("hidden", panel !== p);
  $("duck-dock").classList.toggle("hidden", panel !== "chat");
  if (panel === "threads") paintThreads();
  if (panel === "decisions") paintDecisions();
  if (panel === "settings") paintSettings();
  if (panel === "chat") {
    const id = view.current;
    const changed =
      !before ||
      why === "open" ||
      (id && before.messages[id] !== view.messages[id]) ||
      before.tasks !== view.tasks ||
      (id && (before.states[id] ?? "idle") !== (view.states[id] ?? "idle"));
    if (changed) paintItems();
    paintStream();
    if (!before || before.asks !== view.asks || why === "open") paintAsks();
    paintSpend();
    paintError();
    paintReader();
  }
  paintVoice();
}

function paintTrust(): void {
  const b = $<HTMLButtonElement>("duck-trust");
  const t = view.trust;
  b.classList.toggle("hidden", !t);
  b.classList.toggle("paused", !!t?.paused);
  b.textContent = t?.paused ? "⏸ paused" : "⏸ trust";
  b.title = t?.paused ? "Trust is paused: every consequential call asks. Resume on the desktop." : "Pause trust: every consequential call will ask.";
}

/** The open `<details>` of tool chips, by item key, kept across repaints. */
const openChips = new Set<string>();

function paintItems(): void {
  const list = $("duck-list");
  list.replaceChildren();
  const id = view.current;
  if (!id) {
    list.append(el("div", "duck-empty muted", "A new thread. Ask Duck anything about your sessions."));
    return;
  }
  const messages = view.messages[id];
  if (!messages) {
    list.append(el("div", "duck-empty muted", "loading…"));
    return;
  }
  const active = (view.states[id] ?? "idle") !== "idle";
  for (const it of toItems(messages)) list.append(itemView(it, active));
  if (stuck) toEnd();
}

function itemView(it: Item, active: boolean): HTMLElement {
  switch (it.kind) {
    case "user": {
      const wrap = el("div", "duck-user");
      const bubble = el("div", "bubble", it.text);
      const label = SOURCE_LABEL[it.source];
      if (label) bubble.append(el("div", "src", label));
      wrap.append(bubble);
      return wrap;
    }
    case "reply": {
      const r = el("div", "wb-md duck-reply");
      r.innerHTML = renderMarkdown(it.text); // sanitized by DOMPurify in renderMarkdown
      return r;
    }
    case "tool":
      return toolChip(it, active);
    case "event": {
      const e = el("div", "duck-event", it.text);
      e.title = "from Workbench, not from you";
      return e;
    }
    case "note":
      return editChip(it.text, it.edit.project, [{ label: it.edit.name, before: it.edit.before ?? "", after: it.edit.after ?? "" }]);
    case "plugins":
      return editChip(it.text, it.edit.project, [
        { label: "plugins.json", before: it.edit.before ?? "", after: it.edit.after },
        ...it.edit.scripts.map((s) => ({ label: `scripts/${s.name}`, before: s.before ?? "", after: s.after })),
      ]);
    case "task":
      return taskCard(it.taskId, it.text);
    case "notice":
      return noticeLine(it.notice);
  }
}

function details(key: string, summary: HTMLElement, body: () => HTMLElement): HTMLElement {
  const d = el("details");
  d.open = openChips.has(key);
  d.append(summary);
  let filled = false;
  const fill = () => {
    if (filled || !d.open) return;
    filled = true;
    d.append(body());
  };
  fill();
  d.addEventListener("toggle", () => {
    if (d.open) openChips.add(key);
    else openChips.delete(key);
    fill();
  });
  return d;
}

function toolChip(it: Extract<Item, { kind: "tool" }>, active: boolean): HTMLElement {
  const r = it.result;
  const s = el("summary", "duck-chip");
  s.append(
    el("span", r ? (r.isError ? "needs" : "done") : "muted", r ? (r.isError ? "✕" : "✓") : active ? "◌" : "–"),
    el("span", "name", it.name),
    el("span", "arg", oneLine(it.input)),
  );
  const d = details(it.key, s, () => {
    const pre = el("div", "duck-pre");
    pre.append(el("div", "muted", "input"), document.createTextNode(JSON.stringify(it.input, null, 2)));
    pre.append(el("div", "muted", r ? (r.isError ? "error" : "output") : "no result"), document.createTextNode(r?.text ?? ""));
    return pre;
  });
  d.className = "duck-tool";
  return d;
}

interface DiffFile {
  label: string;
  before: string;
  after: string;
}

function diffBlock(files: DiffFile[]): HTMLElement {
  const box = el("div", "duck-pre duck-diff");
  for (const f of files) {
    if (files.length > 1) box.append(el("div", "muted", f.label));
    const diff = lineDiff(f.before, f.after);
    if (diff.length === 0) box.append(el("div", "muted", "no change"));
    for (const l of diff)
      box.append(l === null ? el("div", "muted", "⋯") : el("div", l.op === "+" ? "done" : l.op === "-" ? "needs" : "", `${l.op} ${l.text}`));
  }
  return box;
}

function editChip(text: string, project: string, files: DiffFile[]): HTMLElement {
  const s = el("summary", "duck-chip");
  s.append(el("span", "name", `✎ ${text}`), el("span", "arg", project));
  const d = details(`edit:${text}:${project}:${files[0]?.after.length}`, s, () => diffBlock(files));
  d.className = "duck-tool";
  return d;
}

function elapsed(from: number | null, to: number | null): string {
  if (from === null) return "";
  const s = Math.max(0, Math.round(((to ?? Date.now()) - from) / 1000));
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

function taskCard(taskId: string, text: string): HTMLElement {
  const task: TaskView | undefined = view.tasks.find((t) => t.id === taskId);
  if (!task) return el("div", "duck-event", `⚙ ${text}`);
  const card = el("div", "duck-task");
  const head = el("div", "head");
  const tone = task.state === "running" || task.state === "queued" ? "working" : task.state === "done" ? "done" : task.state === "closed" ? "muted" : "needs";
  head.append(el("strong", "", `⚙ ${task.title}`), el("span", tone, TASK_STATE[task.state] ?? task.state));
  card.append(head);
  card.append(
    el(
      "div",
      "muted",
      `${task.runner === "api" ? "API · " : ""}${task.model} · ${task.effort} (${task.tier})${task.started !== null ? ` · ${elapsed(task.started, task.finished)}` : ""}`,
    ),
  );
  if (task.why) card.append(el("div", "muted", task.why));
  if (task.headline) card.append(el("div", "headline", task.headline));
  const bar = el("div", "bar");
  if (task.state !== "closed" && task.instanceId) {
    const open = el("button", "", "open console");
    open.type = "button";
    open.onclick = () => deps.console(task.instanceId!);
    bar.append(open);
  }
  if (task.state !== "closed") {
    const close = el("button", "", "close");
    close.type = "button";
    close.onclick = () => post({ type: "task.close", taskId: task.id });
    bar.append(close);
  }
  if (task.tier !== "serious" && task.state !== "queued") {
    const rerun = el("button", "", `re-run ${task.tier === "standard" ? "involved" : "serious"}`);
    rerun.type = "button";
    rerun.onclick = () => post({ type: "task.rerun", taskId: task.id });
    bar.append(rerun);
  }
  if (bar.childElementCount) card.append(bar);
  return card;
}

const NOTICE_GLYPH: Partial<Record<Notice["kind"], string>> = { keys: "⌨", autopilot: "⟳", screen: "▣", reader: "♪" };

function noticeLine(n: Notice): HTMLElement {
  const quiet = n.kind === "stopped" || n.kind === "keys" || n.kind === "autopilot" || n.kind === "screen" || n.kind === "reader";
  return el("div", `duck-notice ${quiet ? "muted" : "needs"}`, `${NOTICE_GLYPH[n.kind] ?? "!"} ${n.text}`);
}

function confirmCard(ask: ConfirmRequest): HTMLElement {
  const card = el("div", "duck-ask");
  const head = el("div");
  head.append(el("span", "needs", "● Duck wants to run "), el("span", "name", ask.name));
  card.append(head);
  if (ask.summary) card.append(el("div", "summary", ask.summary));
  if (ask.review) card.append(diffBlock(ask.review.map((r) => ({ label: r.label, before: r.before ?? "", after: r.after }))));
  const input = () => el("div", "duck-pre", readableInput(ask.input));
  if (ask.summary) card.append(details(`ask:${ask.toolUseId}`, el("summary", "muted", "details"), input));
  else card.append(input());
  const bar = el("div", "bar");
  const allow = el("button", "ok", "allow");
  const deny = el("button", "no", "deny");
  for (const [b, yes] of [
    [allow, true],
    [deny, false],
  ] as const) {
    b.type = "button";
    b.onclick = () => {
      allow.disabled = deny.disabled = true;
      post({ type: "confirm", threadId: ask.threadId, toolUseId: ask.toolUseId, allow: yes });
    };
  }
  bar.append(allow, deny);
  card.append(bar);
  return card;
}

function paintAsks(): void {
  const box = $("duck-asks");
  box.replaceChildren();
  const here = view.asks.filter((a) => a.threadId === view.current);
  const elsewhere = view.asks.filter((a) => a.threadId !== view.current);
  for (const a of here) box.append(confirmCard(a));
  if (elsewhere.length) {
    const b = el(
      "button",
      "duck-elsewhere",
      `● ${elsewhere.length} waiting in ${view.threads.find((t) => t.id === elsewhere[0].threadId)?.title || "another thread"}: open`,
    );
    b.type = "button";
    b.onclick = () => openThread(elsewhere[0].threadId);
    box.append(b);
  }
  box.classList.toggle("hidden", box.childElementCount === 0);
}

function paintSpend(): void {
  const s = view.spend;
  const line = $("duck-spend");
  line.replaceChildren();
  if (!s) return;
  const turn = view.current ? view.turns[view.current] : undefined;
  if (turn !== undefined) line.append(el("span", "", `this turn ${usd(turn)}`));
  line.append(
    el("span", `month ${s.capReached ? "needs" : s.softReached ? "working" : ""}`, `month ${usd(s.monthUsd)} / ${usd(s.limits.hardCapUsd)}`),
  );
}

function paintError(): void {
  const e = $("duck-error");
  e.classList.toggle("hidden", !view.error);
  $("duck-error-text").textContent = view.error ?? "";
}

function paintThreads(): void {
  const list = $("duck-thread-list");
  list.replaceChildren();
  const waiting = new Set(view.asks.map((a) => a.threadId));
  for (const t of view.threads) {
    const b = el("button", t.id === view.current ? "current" : "");
    b.type = "button";
    b.append(
      el("span", "needs dot", waiting.has(t.id) ? "●" : (view.states[t.id] ?? "idle") !== "idle" ? "◐" : ""),
      el("span", "name", t.title || "untitled"),
      el("span", "when", formatAgo(Math.floor(t.updated / 1000))),
    );
    b.onclick = () => openThread(t.id);
    list.append(b);
  }
  if (view.threads.length === 0) list.append(el("div", "muted", "no threads yet"));
}

function decisionRow(d: DecisionRow): HTMLElement {
  const row = el("div", "duck-decision");
  const head = el("div", "head");
  const tone = d.decision === "allow" ? "done" : d.decision === "deny" ? "needs" : "working";
  head.append(
    el("span", tone, d.decision === "allow" ? "allowed" : d.decision === "deny" ? "denied" : "asked"),
    el("span", "name", d.tool.replace(/^assistant:/, "")),
    el("span", "when", formatAgo(Math.floor(d.ts / 1000))),
  );
  row.append(head, el("div", "", d.summary));
  row.append(el("div", "muted", `${d.layer}${d.reason ? `: ${d.reason}` : ""}${d.shadow ? " (logged only)" : ""}`));
  return row;
}

function paintDecisions(): void {
  const t = view.trust;
  $("duck-trust-line").textContent = !t
    ? "Trust didn't load."
    : t.paused
      ? "Trust is paused: every consequential call asks. Resume it on the desktop."
      : "Duck acts without a card on what the rules allow.";
  $("duck-pause").classList.toggle("hidden", !t || t.paused);
  const list = $("duck-decision-list");
  list.replaceChildren();
  for (const d of view.decisions) list.append(decisionRow(d));
  if (view.decisions.length === 0) list.append(el("div", "muted", "Nothing decided yet."));
  $("duck-older").classList.toggle("hidden", !view.decisionsMore);
}

/** Do Not Disturb (V5): "on" is until it's turned off. */
const DND_FOREVER = 8.64e15;

function dndUntil(choice: string): number | null {
  const now = Date.now();
  if (choice === "1h") return now + 3_600_000;
  if (choice === "morning") {
    const d = new Date(now);
    d.setHours(8, 0, 0, 0);
    if (d.getTime() <= now) d.setDate(d.getDate() + 1);
    return d.getTime();
  }
  return choice === "on" ? DND_FOREVER : null;
}

function paintSettings(): void {
  const until = view.dndUntil;
  const on = until !== null && until > Date.now();
  for (const b of document.querySelectorAll<HTMLButtonElement>("#duck-dnd [data-dnd]"))
    b.classList.toggle("on", b.dataset.dnd === (on ? (until >= DND_FOREVER ? "on" : "") : "off"));
  $("duck-dnd-note").textContent = on && until < DND_FOREVER ? `on until ${new Date(until).toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" })}` : "";
  for (const b of document.querySelectorAll<HTMLButtonElement>("#duck-settings [data-pref]")) {
    const [key, value] = (b.dataset.pref ?? "").split("=");
    const now = String(prefs[key as keyof Prefs]);
    b.classList.toggle("on", now === value);
  }
}

function setPrefs(patch: Partial<Prefs>): void {
  prefs = { ...prefs, ...patch };
  store(PREFS_KEY, JSON.stringify(prefs));
  if (patch.duck === false) stopAvatar();
  startAvatar();
  paint("prefs");
}

/** Grow the composer with its text, up to a third of the screen. */
function fitComposer(): void {
  const text = $<HTMLTextAreaElement>("duck-text");
  text.style.height = "auto";
  text.style.height = `${Math.min(text.scrollHeight + 2, window.innerHeight * 0.33)}px`;
}

// ── the overlay ─────────────────────────────────────────────────────────────

/** Open Duck, on `threadId` when given. */
export function openDuck(threadId?: string): void {
  if (threadId) {
    if (view.synced && view.threads.some((t) => t.id === threadId)) openThread(threadId);
    else wantThread = threadId;
  }
  if (!shown) {
    shown = true;
    $("duck-overlay").classList.remove("hidden");
    stuck = true;
    connect();
    startAvatar();
  }
  paint("open");
}

function closeDuck(): void {
  shown = false;
  $("duck-overlay").classList.add("hidden");
  cancelRecording();
  if (talk || talkStarting) stopTalk();
  hush();
  stopAvatar();
  disconnect();
}

/** The thread a tapped push opened the page on (`#duck=…`), once. */
export function takeLaunchThread(): string | null {
  const m = /^#duck=(.+)$/.exec(location.hash);
  if (!m) return null;
  history.replaceState(null, "", location.pathname + location.search);
  return decodeURIComponent(m[1]);
}

/** Wire the overlay. `console` opens a session's console (a link in a reply, a
 *  task's card); `refused` is the device losing access. */
export function initDuck(d: typeof deps): void {
  deps = d;
  $("duckBtn").onclick = () => openDuck();
  $("duck-close").onclick = closeDuck;
  $("duck-thread").onclick = () => {
    panel = panel === "threads" ? "chat" : "threads";
    paint("panel");
  };
  $("duck-new").onclick = () => openThread(null);
  $("duck-menu").onclick = () => {
    panel = panel === "settings" ? "chat" : "settings";
    paint("panel");
  };
  $("duck-trust").onclick = () => {
    if (view.trust && !view.trust.paused) post({ type: "trust.pause" });
    panel = "decisions";
    post({ type: "trust.decisions", before: null });
    paint("panel");
  };
  $("duck-pause").onclick = () => post({ type: "trust.pause" });
  $("duck-decisions-btn").onclick = () => {
    panel = "decisions";
    post({ type: "trust.decisions", before: null });
    paint("panel");
  };
  $("duck-older").onclick = () => post({ type: "trust.decisions", before: view.decisions[view.decisions.length - 1]?.id ?? null });
  for (const b of document.querySelectorAll<HTMLButtonElement>(".duck-back")) b.onclick = () => ((panel = "chat"), paint("panel"));
  for (const b of document.querySelectorAll<HTMLButtonElement>("#duck-settings [data-pref]"))
    b.onclick = () => {
      const [key, value] = (b.dataset.pref ?? "").split("=");
      setPrefs({ [key]: value === "true" ? true : value === "false" ? false : value } as Partial<Prefs>);
    };
  $("duck-error-close").onclick = () => {
    view = { ...view, error: null };
    paintError();
  };
  for (const b of document.querySelectorAll<HTMLButtonElement>("#duck-dnd [data-dnd]"))
    b.onclick = () => post({ type: "dnd", until: dndUntil(b.dataset.dnd ?? "off") });
  for (const b of document.querySelectorAll<HTMLButtonElement>("#duck-reader [data-reader]"))
    b.onclick = () => readerButton(b.dataset.reader ?? "");
  $("duck-avatar").onclick = () => {
    hush();
    paintVoice();
  };

  const s = scroller();
  s.addEventListener("scroll", () => (stuck = s.scrollHeight - s.scrollTop - s.clientHeight < STICK_PX), { passive: true });
  new ResizeObserver(() => {
    if (stuck) toEnd();
  }).observe(s);
  s.addEventListener("click", (e) => {
    const a = e.target instanceof Element ? e.target.closest("a[href]") : null;
    if (!a) return;
    const href = a.getAttribute("href");
    const session = sessionLink(href);
    if (session) {
      e.preventDefault();
      deps.console(session);
    } else if (!/^(https?:|mailto:)/i.test(href ?? "")) e.preventDefault();
  });

  const text = $<HTMLTextAreaElement>("duck-text");
  text.addEventListener("input", () => {
    if (!text.value.trim()) dictated = false;
    fitComposer();
  });
  text.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      sendComposer();
    }
  });
  const sendBtn = $("duck-send");
  // Tapping send must not close the on-screen keyboard.
  sendBtn.addEventListener("pointerdown", (e) => {
    if (document.activeElement === text) e.preventDefault();
  });
  sendBtn.onclick = sendComposer;
  $("duck-stop").onclick = stopAll;
  wireMic();
  wireTalk();

  document.addEventListener("visibilitychange", () => {
    if (!shown) return;
    if (document.hidden) {
      cancelRecording();
      if (talk || talkStarting) stopTalk();
      hush();
      stopAvatar();
      disconnect();
    } else {
      connect();
      startAvatar();
    }
  });
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.addEventListener("message", (e: MessageEvent<{ type?: string; threadId?: string }>) => {
      if (e.data?.type === "open-duck" && e.data.threadId) openDuck(e.data.threadId);
    });
  }
}
