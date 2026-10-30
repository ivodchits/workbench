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
// - V7: each sentence that starts playing is told to the desktop (`conv.said`): it
//   cancels that sentence's echo (its audio is the reference) and doesn't take its
//   words for yours. So conversation mode speaks in the desktop's voice. "echo
//   path" picks how the voice leaves the page (`duckSpeech.ts`), for measuring
//   which one the browser's own echo cancellation helps with.
// - R3: the installed app's shortcuts and shares open Duck (`launchDuck`, from
//   `launch.ts`): "Talk to Duck" on a big tap-to-talk button (the mic needs a tap),
//   "Ask Duck" on the composer, "New task" on a new thread, "What needs me?" asked
//   at once, and a share on a new thread with the shared item above the composer
//   (one tap to summarize it, make a task of it or remember it). "the app opens
//   on" makes Duck the start view, and the settings say how to install the app.
// - R4, H5: inside Duck's Android app (`duckApp.ts`) the page is also the phone
//   host, arms the reminders, opens listening from the assistant gesture and the
//   widget (conversation mode from the tile), runs the fast path's commands
//   itself, and keeps conversation mode going with the screen off.
// - G1: files go with a message: 📎 (the camera offered for images), a paste, or
//   a share from another app. Each is uploaded at once (`uploads.ts`; a HEIC photo
//   redrawn as a JPEG first, `images.ts`) and shown as a chip above the
//   composer; the next typed or dictated message takes them.

import { langOf, Sentences } from "../assistant/speakable";
import {
  USER_SOURCES,
  type AutopilotView,
  type ConfirmRequest,
  type DrawingView,
  type DecisionRow,
  type Notice,
  type TaskView,
  type TurnState,
} from "../assistant/protocol";
import type { DuckMode } from "../panels/Assistant/duck3d";
import { startDuckCanvas, type DuckLook } from "../panels/Assistant/duckCanvas";
import { lineDiff, oneLine, readableInput, reminderFiles, sessionLink, toItems, type Item } from "../panels/Assistant/view";
import { renderMarkdown } from "../panels/Editor/markdown";
import type { EchoPath, RemoteConvFrame, RemoteConvMessage, RemoteDuckFrame, RemoteDuckMessage, RemoteHostMessage } from "../remote/protocol";
import { formatAgo } from "../util/format";
import { $, el } from "./dom";
import { apply, emptyView, userText, type DuckView } from "./duckStore";
import { audioContext, browserOut, fetchPart, playbackLevel, setEchoPath, unlock } from "./duckSpeech";
import { chime, stream, streamNative, type Streaming } from "./converse";
import * as duckApp from "./duckApp";
import {
  appSettings as getAppSettings,
  LOADER_URL,
  phoneKey,
  phoneSpend,
  saveAddress,
  setAppSettings,
  setPhoneKey,
  type AppSettings,
} from "./native";
import { fastPath } from "./fastPath";
import { SpeechQueue } from "./speechQueue";
import { micAvailable, record, type Recording } from "./mic";
import { api, ApiError, checkAccess, openSocket } from "./net";
import { SHARE_ASKS, shareBody, shareLines, shareMessage, STATUS_ASK, takeShare, TASK_LEAD, type Launch } from "./launch";
import { createUploader } from "./uploads";
import { pastedName, readyImage } from "./images";
import { showDrawing, shownDrawing } from "./drawingView";
import { openFile, opensAsPicture } from "./fileOpen";
import { anyUnread, loadSeen, markSeen, noteMessage, prune, saveSeen, unreadOf, type Seen, type ThreadStamp } from "./unread";
import { openSketch } from "./sketch";
import { sizeText, type AttachmentRef } from "../assistant/attachments";
import { AFTER_MS, BEFORE_MS, createVoiceFiles, pillText, type Sent } from "../assistant/voiceFiles";

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
  /** How Duck's voice leaves the page (V7). */
  echoPath: EchoPath;
  /** What the app shows when it opens plainly (R3). */
  openOn: "dashboard" | "duck";
}

const DEFAULT_PREFS: Prefs = {
  speak: "voice",
  voice: "desktop",
  sendNow: true,
  duck: true,
  echoPath: "separate",
  // Duck's own app opens on Duck.
  openOn: duckApp.inApp() ? "duck" : "dashboard",
};
/** The "put Duck on your home screen" line was dismissed. */
const INSTALL_HINT_KEY = "wb-duck-install-hint";
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
setEchoPath(prefs.echoPath);
let view: DuckView = emptyView();
let adopting = false;
let shown = false;

/** What of Duck's threads this phone has seen (the unread marks). */
let seen: Seen | null = null;
/** The threads as the dashboard's snapshot has them: fresh while Duck's socket
 *  is closed, for the Duck button's dot. */
let snapThreads: readonly ThreadStamp[] | null = null;

function setSeen(next: Seen): void {
  if (next === seen) return;
  seen = next;
  saveSeen(next);
}

/** The thread being looked at right now, if any. */
function viewing(): string | null {
  return shown && !document.hidden && panel === "chat" ? view.current : null;
}

/** Mark the thread on screen seen, up to its last change. */
function seeCurrent(): void {
  const id = viewing();
  const t = id ? view.threads.find((x) => x.id === id) : undefined;
  if (seen && t) setSeen(markSeen(seen, t.id, t.updated));
}

/** The unread dots: on the Duck button (any thread), and on the thread picker
 *  (any thread but the one open). */
function paintUnread(): void {
  if (!seen) return;
  const rows = view.synced && shown ? view.threads : (snapThreads ?? view.threads);
  $("duckBtn").classList.toggle("unread", anyUnread(seen, rows));
  $("duck-thread").classList.toggle("unread", anyUnread(seen, view.threads, view.current));
}

/** The dashboard's latest list of Duck's threads (the snapshot's `duckThreads`). */
export function noteDuckThreads(threads: readonly ThreadStamp[] | undefined): void {
  if (!threads) return;
  snapThreads = threads;
  if (seen) setSeen(prune(seen, threads.map((t) => t.id)));
  paintUnread();
}
let panel: "chat" | "threads" | "decisions" | "settings" | "tap" = "chat";
let ws: WebSocket | null = null;
let retry: ReturnType<typeof setTimeout> | null = null;
/** The thread a push or a link asked for, opened once the list is in. */
let wantThread: string | null = null;
let stopDuck: (() => void) | null = null;
let stuck = true;
let deps: { console: (instanceId: string) => void; refused: () => void } = { console: () => {}, refused: () => {} };
// R3: what a shortcut or a share asked for.
/** Open on a new thread once the threads are known, not the last one. */
let fresh = false;
/** Sent once the threads are known ("What needs me?"). */
let pendingAsk: string | null = null;
/** A share waiting to go with a message: the message's part, and what's shown. */
let shared: { body: string; preview: string } | null = null;
/** The browser's install prompt, kept for the settings' button. */
let installPrompt: (Event & { prompt(): Promise<void> }) | null = null;

// Speech: the queue, and the phone's own voice's reply.
const queue = new SpeechQueue(
  browserOut,
  () => paintVoice(),
  (part, how) => {
    if (talk) post({ type: "conv.said", text: part.text, ...(how === "audio" && part.id && { id: part.id }), voice: how === "audio" ? "desktop" : "phone" });
  },
);
/** Hushed: nothing more is spoken until the next send. */
let hushed = false;
/** Messages sent for the phone's own voice, waiting to be seen stored. */
const nativeWanted: string[] = [];
let native: { threadId: string; cut: Sentences } | null = null;

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
/** The thread whose reply the phone's own voice spoke last, and the thread Duck
 *  moved the conversation into from it (A7), whose next reply it speaks too. */
let nativeLast: string | null = null;
let nativeFollow: string | null = null;

// ── the socket ──────────────────────────────────────────────────────────────

function post(msg: RemoteDuckMessage | RemoteConvMessage | RemoteHostMessage): void {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

// ── files (G1) ──────────────────────────────────────────────────────────────

const uploader = createUploader((m) => post(m));
/** Stored, waiting to go with the next message. */
let staged: AttachmentRef[] = [];
/** When each staged file came (G2: ones from just before you talk go with it). */
const stagedAt = new Map<AttachmentRef, number>();
/** Picked or shared, waiting for the socket to go up; `voice`: for the voice turn
 *  (G2), which counts it meanwhile. */
const toUpload: { blob: Blob; name: string; voice?: boolean }[] = [];
let uploading = 0;
let filesError = "";

function addStaged(files: readonly AttachmentRef[]): void {
  for (const file of files)
    if (!staged.some((s) => s.id === file.id && s.name === file.name)) {
      staged = [...staged, file];
      stagedAt.set(file, Date.now());
    }
}

function stageFiles(files: { blob: Blob; name: string }[]): void {
  // While you talk, or just after, they go with what you say (G2).
  const voice = turnFiles.claims();
  if (voice) turnFiles.expect(files.length);
  toUpload.push(...files.map((f) => ({ ...f, voice })));
  filesError = "";
  void pumpUploads();
  paintFiles();
}

async function pumpUploads(): Promise<void> {
  let voiceDone: AttachmentRef[] = [];
  let voiceSettled = 0;
  while (toUpload.length && ws?.readyState === WebSocket.OPEN) {
    const f = toUpload.shift()!;
    if (!f.voice) uploading++;
    paintFiles();
    try {
      // A photo Duck can't read as it is (HEIC) goes as a JPEG.
      const ready = await readyImage(f.blob, f.name);
      const file = await uploader.upload(ready.blob, ready.name);
      if (f.voice) voiceDone.push(file);
      else addStaged([file]);
    } catch (e) {
      filesError = `${f.name}: ${e instanceof Error ? e.message : String(e)}`;
    } finally {
      if (f.voice) voiceSettled++;
      else uploading--;
      // A voice turn's files arrive together, so a share of three is one late send.
      if (voiceSettled && !toUpload.some((u) => u.voice)) {
        turnFiles.arrive(voiceDone, voiceSettled);
        voiceDone = [];
        voiceSettled = 0;
      }
      paintFiles();
    }
  }
}

// ── files with a voice turn (G2) ────────────────────────────────────────────

const turnFiles = createVoiceFiles({
  now: () => Date.now(),
  later(ms, fn) {
    const t = setTimeout(fn, ms);
    return () => clearTimeout(t);
  },
  changed: () => paintFiles(),
  back(files) {
    addStaged(files);
    paintFiles();
  },
});

/** The last voice turn sent, kept over a reload: a share opens the page afresh. */
const LAST_VOICE = "wb-duck-last-voice";

function rememberVoice(threadId: string | null): void {
  try {
    localStorage.setItem(LAST_VOICE, JSON.stringify({ threadId, at: Date.now() }));
  } catch {
    // Without storage, a share after a reload starts its own message.
  }
}

function lastVoice(): { threadId: string | null; at: number } | null {
  try {
    const v = JSON.parse(localStorage.getItem(LAST_VOICE) ?? "null") as { threadId: string | null; at: number } | null;
    return v && Date.now() - v.at <= AFTER_MS ? v : null;
  } catch {
    return null;
  }
}

/** Where a voice turn's late files go: its thread (the engine starts a turn that
 *  hasn't stood again with them, or they follow it). */
function lateTo(threadId: string | null): Sent {
  return {
    late(files) {
      if (queue.speaking) hush();
      const to = threadId ?? view.current;
      if (to) post({ type: "turn.files", threadId: to, attachments: files.map((f) => f.id) });
      else send("", true, null, files);
    },
  };
}

/** The staged files from the last `ms`, out of the composer: they go with the
 *  voice turn starting. */
function takeRecentStaged(ms: number): AttachmentRef[] {
  const now = Date.now();
  const recent = staged.filter((f) => now - (stagedAt.get(f) ?? 0) <= ms);
  if (recent.length) {
    staged = staged.filter((f) => !recent.includes(f));
    paintFiles();
  }
  return recent;
}

/** A file's chip: its thumbnail or a sign, its name and size; × when staged. In
 *  the thread it is a button: a picture opens full screen, anything else saves. */
function fileChip(f: AttachmentRef, remove?: () => void): HTMLElement {
  const chip = el(remove ? "span" : "button", "duck-file");
  if (chip instanceof HTMLButtonElement) {
    chip.type = "button";
    chip.title = `${f.name} · ${opensAsPicture(f.mime) ? "tap to view" : "tap to save"}`;
    chip.onclick = () =>
      openFile(f, (why) => {
        filesError = why;
        paintFiles();
      });
  }
  if (f.thumb?.startsWith("data:image/jpeg;base64,")) {
    const img = document.createElement("img");
    img.src = f.thumb;
    img.alt = "";
    chip.append(img);
  } else chip.append(el("span", "sign", f.mime.startsWith("image/") ? "🖼" : f.mime === "application/pdf" ? "📕" : "📄"));
  chip.append(el("span", "name", f.name), el("span", "size", sizeText(f.size)));
  if (remove) {
    const x = el("button", "", "✕");
    x.type = "button";
    x.setAttribute("aria-label", `remove ${f.name}`);
    x.onclick = remove;
    chip.append(x);
  }
  return chip;
}

function fileRow(files: readonly AttachmentRef[]): HTMLElement {
  const row = el("div", "duck-files");
  for (const f of files) row.append(fileChip(f));
  return row;
}

function paintFiles(): void {
  const box = $("duck-staged");
  box.replaceChildren();
  // The voice turn's files first (G2): "🎤 + 2 files", or the wait.
  const turn = turnFiles.files();
  const voiceLine = turn.length || turnFiles.coming() || turnFiles.missing();
  if (voiceLine) {
    box.append(el("div", "duck-turnfiles", pillText(turn.length, turnFiles.missing(), turnFiles.coming())));
    for (const f of turn) box.append(fileChip(f));
  }
  for (const f of staged)
    box.append(
      fileChip(f, () => {
        staged = staged.filter((s) => s !== f);
        paintFiles();
      }),
    );
  const waiting = uploading + toUpload.length;
  if (waiting) box.append(el("span", "muted", `adding ${waiting}…`));
  if (filesError) box.append(el("div", "error", filesError));
  box.classList.toggle("hidden", !staged.length && !waiting && !filesError && !voiceLine);
}

/** In the app, conversation mode goes on with the screen off (R4). */
function talkAway(): boolean {
  return duckApp.inApp() && !!(talk || talkStarting);
}

/** What the app asked for before the socket was open: done once it is. */
let onLive: (() => void) | null = null;

function connect(): void {
  if (ws || !shown || (document.hidden && !talkAway())) return;
  const socket = openSocket("/api/assistant");
  ws = socket;
  let opened = false;
  paintConn("connecting…");
  socket.onopen = () => {
    opened = true;
    paintConn("● live", "live");
    post({ type: "sync" });
    if (view.current) post({ type: "thread.open", threadId: view.current });
    void duckApp.connected();
    void pumpUploads();
    const then = onLive;
    onLive = null;
    then?.();
  };
  socket.onclose = () => {
    if (ws !== socket) return;
    ws = null;
    uploader.drop();
    paintConn("○ offline", "off");
    if (talk || talkStarting) endTalk("The connection dropped, so conversation mode is off.");
    if (!shown || (document.hidden && !talkAway())) return;
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

// ── drawings (G3) ───────────────────────────────────────────────────────────

/** The drawings this page has heard of, and one asked for to show when it comes. */
const drawingsSeen = new Map<string, DrawingView>();
let wantDrawing: { id: string; n: number | null } | null = null;

/** Show a drawing full screen; Duck keeps its worker warm while it's open. */
function openDrawing(id: string, n: number | null): void {
  const d = drawingsSeen.get(id);
  post({ type: "drawing.get", drawingId: id });
  if (!d) {
    wantDrawing = { id, n };
    return;
  }
  post({ type: "canvas", drawingId: id });
  showDrawing(d, n, () => post({ type: "canvas", drawingId: null }), markUp);
}

/** The sketch pad's hooks into this page (G5): staging, 📎 and the mic. */
const sketchHooks = () => ({ stage: stageFiles, attach: $("duck-attach"), mic: $("duck-mic") });

/** Mark up a drawing (G5): the pad opens on its picture, named after it. */
function markUp(url: string, size: { width: number; height: number }, name: string): void {
  openSketch(sketchHooks(), { background: { kind: "image", name }, image: url, size });
}

function onDrawing(d: DrawingView, open: boolean): void {
  drawingsSeen.set(d.id, d);
  const shown = shownDrawing();
  if (open && d.versions.length) openDrawing(d.id, null);
  else if (wantDrawing?.id === d.id) {
    const n = wantDrawing.n;
    wantDrawing = null;
    openDrawing(d.id, n);
  } else if (shown?.id === d.id) showDrawing(d, shown.n, () => post({ type: "canvas", drawingId: null }), markUp);
}

/** A drawing's card in the thread: its thumbnail; a tap shows it. */
function drawingCard(it: Extract<Item, { kind: "drawing" }>): HTMLElement {
  const d = it.drawing;
  const card = el("button", "duck-drawcard");
  card.type = "button";
  const thumb = d.png?.thumb;
  if (thumb?.startsWith("data:image/jpeg;base64,") || thumb?.startsWith("data:image/png;base64,")) {
    const img = el("img");
    img.src = thumb;
    img.alt = "";
    card.append(img);
  } else card.append(el("span", "glyph", "✎"));
  card.append(el("span", "", `✎ ${it.text}`));
  card.onclick = () => openDrawing(d.id, d.n);
  return card;
}

function onFrame(f: RemoteDuckFrame): void {
  if (duckApp.onAppFrame(f) || uploader.onFrame(f)) return;
  if (f.type === "drawing") {
    onDrawing(f.drawing, f.open === "phone");
    return;
  }
  if (f.type.startsWith("conv.")) {
    onConv(f as RemoteConvFrame);
    return;
  }
  if (f.type === "tts") {
    // Duck's news (V5) plays only where this phone's speaking isn't off.
    const news = f.reply.startsWith("news");
    if (!hushed && !(news && prefs.speak === "off")) queue.add({ audio: fetchPart(f.id), text: f.text, lang: langOf(f.text), id: f.id });
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
  if (seen && f.type === "message") {
    const m = f.message;
    setSeen(viewing() === m.threadId ? markSeen(seen, m.threadId, m.ts) : noteMessage(seen, m));
  } else if (seen && f.type === "threads") setSeen(prune(seen, view.threads.map((t) => t.id)));
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
    openThread(fresh ? null : (pick ?? view.threads[0]?.id ?? null));
    fresh = false;
    if (pendingAsk) {
      send(pendingAsk, false);
      pendingAsk = null;
    }
  } else if (f.type === "threads" && wantThread && view.threads.some((t) => t.id === wantThread)) {
    openThread(wantThread);
    wantThread = null;
  }
  speakNative(f);
  paint(f.type, before);
}

/** The phone's own voice: cut the reply to a message sent for it into sentences. */
function speakNative(f: RemoteDuckFrame): void {
  if (f.type === "message" && f.message.role === "user" && USER_SOURCES.has(f.message.source)) {
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
  // The tap-to-talk screen stays until it's tapped.
  if (panel !== "tap") panel = "chat";
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
function send(
  text: string,
  voice: boolean,
  talked: { provisional: boolean } | null = null,
  turn: readonly AttachmentRef[] = [],
): void {
  const body = text.trim();
  // A voice turn's own files (G2), and what's in the composer unless it's a
  // conversation's turn.
  const files = [...turn, ...(talked ? [] : staged)];
  if (!body && !files.length) return;
  if (!talked && staged.length) {
    staged = [];
    paintFiles();
  }
  unlock();
  hush();
  hushed = false;
  const speak = !!talked || prefs.speak === "always" || (prefs.speak === "voice" && voice);
  // Conversation mode speaks in the desktop's voice: its audio is what the desktop
  // cancels the echo of (V7); the phone's own voice it can't.
  const phoneVoice = prefs.voice === "phone" && !talked;
  if (speak && phoneVoice) nativeWanted.push(body);
  if (view.current === null) adopting = true;
  post({
    type: "send",
    threadId: view.current,
    // What was on screen when the assistant gesture opened the app (H5).
    text: duckApp.withScreen(body),
    ...(voice && { voice: true }),
    ...(speak && !phoneVoice && { speak: true }),
    ...(talked?.provisional && { provisional: true }),
    ...(files.length && { attachments: files.map((f) => f.id) }),
  });
  stuck = true;
}

/** Send, unless the phone runs it itself (the fast path, H5). */
async function sendOrRun(text: string, voice: boolean): Promise<void> {
  const said = staged.length ? null : await duckApp.runFast(text);
  if (said) setVoiceNote(said);
  else send(text, voice);
}

function sendComposer(): void {
  const text = $<HTMLTextAreaElement>("duck-text");
  if (!text.value.trim() && !shared && !staged.length) return;
  // Files still going up go with this message once they're there.
  if (uploading || toUpload.length) return;
  if (ws?.readyState !== WebSocket.OPEN) {
    // Unreachable: the phone's own commands still run.
    if (!shared && duckApp.inApp() && fastPath(text.value)) {
      void sendOrRun(text.value, dictated);
      text.value = "";
      fitComposer();
    }
    return;
  }
  if (shared) sendShare(text.value, dictated);
  else void sendOrRun(text.value, dictated);
  text.value = "";
  dictated = false;
  fitComposer();
}

/** Send the waiting share with `ask`. */
function sendShare(ask: string, voice: boolean): void {
  if (!shared || ws?.readyState !== WebSocket.OPEN) return;
  send(shareMessage(ask, shared.body), voice);
  shared = null;
  paintShare();
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
  post({ type: "conv.start", path: prefs.echoPath, voice: "desktop" });
  try {
    const up = (frame: ArrayBuffer) => {
      if (ws?.readyState === WebSocket.OPEN) ws.send(frame);
    };
    // In the app the mic is native, and keeps going with the screen off (R4).
    const s = duckApp.inApp() ? await streamNative(up) : await stream(up, prefs.echoPath === "shared" ? audioContext() : undefined);
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
  turnFiles.closed();
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
      // You're talking: drops go with what you say (G2).
      if (f.state === "hearing") turnFiles.opened(takeRecentStaged(BEFORE_MS));
      else turnFiles.closed();
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
      turnFiles.turn(t.text, (files) => {
        if (!id || (view.states[id] ?? "idle") !== "idle") return false;
        // The phone's own command waits for the turn to stand (H5).
        if (!files.length && duckApp.inApp() && fastPath(t.text)) return false;
        send(t.text, true, { provisional: true }, files);
        talkSent.set(t.id, id);
        rememberVoice(id);
        return lateTo(id);
      });
      return;
    }
    case "withdrawn": {
      // You went on talking: the files wait for the longer words.
      turnFiles.cancel();
      turnFiles.unsend();
      const id = talkSent.get(t.id);
      talkSent.delete(t.id);
      if (id) post({ type: "turn.withdraw", threadId: id });
      return;
    }
    case "final": {
      const id = talkSent.get(t.id);
      talkSent.delete(t.id);
      if (id) post({ type: "turn.commit", threadId: id });
      else
        turnFiles.turn(t.text, (files) => {
          if (!files.length && duckApp.inApp() && fastPath(t.text))
            void duckApp.runFast(t.text).then((said) => said && setVoiceNote(said));
          else send(t.text, true, { provisional: false }, files);
          rememberVoice(view.current);
          return lateTo(view.current);
        });
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
    turnFiles.opened(takeRecentStaged(BEFORE_MS));
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
  turnFiles.closed();
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
    if (prefs.sendNow)
      turnFiles.turn(text, (files) => {
        const thread = view.current;
        // With files it's Duck's, not the phone's fast path.
        if (files.length || staged.length) send(text, true, null, files);
        else void sendOrRun(text, true);
        rememberVoice(thread);
        return lateTo(thread);
      });
    else {
      turnFiles.turn(text, (files) => {
        addStaged(files);
        paintFiles();
      });
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
  turnFiles.closed();
}

/** Listen for one request, sent once you stop talking (the assistant gesture and
 *  the widget's button, R4). The desktop out of reach, the phone's own
 *  recognizer hears it, for the fast path. */
function listenOnce(): void {
  openDuck();
  panel = "chat";
  paint("panel");
  if (ws?.readyState !== WebSocket.OPEN) {
    onLive = listenOnce;
    setVoiceNote("connecting…");
    setTimeout(() => {
      if (onLive !== listenOnce) return;
      onLive = null;
      void duckApp.listenOffline(setVoiceNote);
    }, 4000);
    return;
  }
  if (recording || starting) return;
  starting = startRecording().finally(() => (starting = null));
  void starting.then(() => {
    const r = recording;
    if (!r) return;
    setVoiceNote("listening…");
    const began = Date.now();
    let floor = 1;
    let heard = 0;
    let quiet = 0;
    const tick = setInterval(() => {
      if (recording !== r) return clearInterval(tick);
      const l = r.level();
      floor = Math.min(floor, Math.max(l, 0.01));
      if (l > Math.max(0.06, floor * 3)) {
        heard += 100;
        quiet = 0;
      } else quiet += 100;
      if (heard >= 200 && quiet >= 1200) {
        clearInterval(tick);
        void finishRecording();
      } else if (!heard && Date.now() - began > 7000) {
        clearInterval(tick);
        cancelRecording();
        setVoiceNote("Didn't hear anything.");
      }
    }, 100);
  });
}

/** Conversation mode from the app's tile (R4): no tap needed for the mic there. */
function talkFromApp(): void {
  openDuck();
  panel = "chat";
  paint("panel");
  if (ws?.readyState === WebSocket.OPEN) void startTalk();
  else onLive = () => void startTalk();
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
  paintTap();
}

/** The tap-to-talk screen: the button works once the desktop is there. */
function paintTap(): void {
  const live = ws?.readyState === WebSocket.OPEN;
  const b = $<HTMLButtonElement>("duck-tap-btn");
  b.disabled = !live || !micAvailable();
  b.textContent = live ? "tap to talk" : "connecting…";
  $("duck-tap-note").textContent = micAvailable()
    ? "Conversation mode: just talk, and Duck answers out loud."
    : "Conversation mode needs the mic, which this page can't have here (open the https address).";
}

function paintShare(): void {
  $("duck-share").classList.toggle("hidden", !shared);
  $("duck-share-text").textContent = shared?.preview ?? "";
  $<HTMLTextAreaElement>("duck-text").placeholder = shared ? "or say what to do with it…" : "ask Duck…";
}

/** Installed: opened from its own icon, not in a browser tab. */
function installed(): boolean {
  return matchMedia("(display-mode: standalone)").matches || (navigator as { standalone?: boolean }).standalone === true;
}

function paintInstall(): void {
  let dismissed = false;
  try {
    dismissed = localStorage.getItem(INSTALL_HINT_KEY) !== null;
  } catch {
    // no storage: show it
  }
  $("duck-install").classList.toggle("hidden", installed() || dismissed);
}

function homeNote(): string {
  if (installed())
    return "Installed. Long-press its icon for Talk to Duck, Ask Duck, New task and What needs me?, and drag one to the home screen for a one-tap button. Share a page to Workbench to hand it to Duck.";
  if (!isSecureContext) return "The app installs from the https (public) address, not this one.";
  if (installPrompt) return "Install the app for its own icon, Duck's shortcuts and sharing to Duck.";
  return "In the browser's ⋮ menu, choose “Install app” (or “Add to Home screen”). Then long-press the new icon for Duck's shortcuts.";
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
        : queue.speaking && (prefs.voice === "desktop" || talk)
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
  for (const p of ["chat", "threads", "decisions", "settings", "tap"] as const) $(`duck-${p}`).classList.toggle("hidden", panel !== p);
  $("duck-dock").classList.toggle("hidden", panel !== "chat");
  if (panel === "tap") paintTap();
  if (panel === "threads") paintThreads();
  if (panel === "decisions") paintDecisions();
  if (panel === "settings") paintSettings();
  if (panel === "chat") {
    // On screen, so seen: opened, come back to, or written in as you watch.
    seeCurrent();
    const id = view.current;
    const changed =
      !before ||
      why === "open" ||
      (id && before.messages[id] !== view.messages[id]) ||
      before.tasks !== view.tasks ||
      before.autopilots !== view.autopilots ||
      (id && (before.states[id] ?? "idle") !== (view.states[id] ?? "idle"));
    if (changed) paintItems();
    paintStream();
    if (!before || before.asks !== view.asks || why === "open") paintAsks();
    paintSpend();
    paintError();
    paintReader();
    paintShare();
    paintInstall();
  }
  paintVoice();
  paintUnread();
  duckApp.widgetLine(widgetText());
}

/** The app's widget line (R4): what needs you, else what Duck's doing. */
function widgetText(): string {
  if (view.asks.length) return view.asks.length === 1 ? "Duck is waiting for a yes or no" : `${view.asks.length} cards wait for you`;
  const busy = Object.values(view.states).find((st) => st !== "idle");
  if (busy) return `Duck: ${STATE_LABEL[busy]}`;
  if (talk) return "Talking with Duck";
  return "Duck is here";
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
  // The thread's autopilots, last: where each run is, with its buttons.
  for (const a of view.autopilots.filter((x) => x.threadId === id)) list.append(autopilotCard(a));
  if (stuck) toEnd();
}

function autopilotCard(a: AutopilotView): HTMLElement {
  const card = el("div", "duck-task");
  const head = el("div", "head");
  head.append(el("strong", "", `⟳ ${a.session}`), el("span", a.state === "running" ? "working" : "needs", a.state));
  card.append(head, el("div", "muted", a.text));
  const bar = el("div", "bar");
  for (const action of [a.state === "running" ? "pause" : "resume", "stop"] as const) {
    const b = el("button", "", action);
    b.type = "button";
    b.onclick = () => post({ type: "autopilot", instanceId: a.instanceId, action });
    bar.append(b);
  }
  card.append(bar);
  return card;
}

function itemView(it: Item, active: boolean): HTMLElement {
  switch (it.kind) {
    case "files": {
      const wrap = el("div", "duck-event", it.text);
      wrap.append(fileRow(it.files));
      return wrap;
    }
    case "user": {
      const wrap = el("div", "duck-user");
      const bubble = el("div", "bubble", it.text);
      if (it.files?.length) bubble.prepend(fileRow(it.files));
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
    case "memory":
      return editChip(it.text, "core memory", [{ label: "core.md", before: it.edit.before ?? "", after: it.edit.after }]);
    case "reminder":
      return editChip(it.text, "reminders", reminderFiles(it.edit));
    case "task":
      return taskCard(it.taskId, it.text);
    case "drawing":
      return drawingCard(it);
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

const NOTICE_GLYPH: Partial<Record<Notice["kind"], string>> = { keys: "⌨", autopilot: "⟳", screen: "▣", reader: "♪", budget: "$", compacted: "⇲", reminder: "⏰" };

function noticeLine(n: Notice): HTMLElement {
  const quiet = n.kind === "stopped" || n.kind === "keys" || n.kind === "autopilot" || n.kind === "screen" || n.kind === "reader" || n.kind === "compacted";
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
  // A card with choices (B2: the login card) has a button per way to allow it.
  const yes = ask.choices?.length ? ask.choices : [{ id: "", label: "allow" }];
  const buttons = [...yes.map((c) => ({ b: el("button", "ok", c.label), allow: true, choice: c.id })), { b: el("button", "no", ask.denyLabel ?? "deny"), allow: false, choice: "" }];
  for (const { b, allow, choice } of buttons) {
    b.type = "button";
    b.onclick = () => {
      for (const x of buttons) x.b.disabled = true;
      post({ type: "confirm", threadId: ask.threadId, toolUseId: ask.toolUseId, allow, ...(choice && { choice }) });
    };
  }
  bar.append(...buttons.map((x) => x.b));
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
    const news = seen ? unreadOf(seen, t) : { unread: false, n: 0 };
    const b = el("button", (t.id === view.current ? "current" : "") + (news.unread ? " unread" : ""));
    b.type = "button";
    b.append(
      el("span", "needs dot", waiting.has(t.id) ? "●" : (view.states[t.id] ?? "idle") !== "idle" ? "◐" : ""),
      el("span", "name", t.title || "untitled"),
    );
    // New since this phone last looked: a count when it heard them come in.
    if (news.unread) {
      const tag = el("span", "new", news.n ? String(news.n) : "new");
      tag.setAttribute("aria-label", news.n ? `${news.n} new` : "new messages");
      b.append(tag);
    }
    b.append(el("span", "when", formatAgo(Math.floor(t.updated / 1000))));
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
  $("duck-home-note").textContent = homeNote();
  $("duck-home-install").classList.toggle("hidden", !installPrompt || installed());
  $("duck-app-settings").classList.toggle("hidden", !duckApp.inApp());
  for (const b of document.querySelectorAll<HTMLButtonElement>("#duck-unlock [data-unlock]"))
    b.classList.toggle("on", b.dataset.unlock === String(appSettings?.requireUnlock ?? true));
}

/** The app's own settings (R4), as last read. */
let appSettings: AppSettings | null = null;

/** The phone brain's key and this month's spend (H7), in the app's settings. */
async function phoneBrainLine(): Promise<void> {
  const [key, spend] = await Promise.all([phoneKey(), phoneSpend()]).catch(() => [null, null] as const);
  if (!key || !spend) return;
  $("duck-phone-brain").textContent = key.set
    ? `Key …${key.hint ?? ""}: $${spend.usd.toFixed(2)} of $${spend.cap.toFixed(2)} this month. An empty key forgets it.`
    : "No key: offline, only timers, alarms, the flashlight and play / pause work.";
}

function setPrefs(patch: Partial<Prefs>): void {
  prefs = { ...prefs, ...patch };
  store(PREFS_KEY, JSON.stringify(prefs));
  setEchoPath(prefs.echoPath);
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
  paintUnread();
}

/** Duck is the start view (the "the app opens on" setting). */
export function duckOnStart(): boolean {
  return prefs.openOn === "duck";
}

/** Open Duck as a shortcut or a share asked (R3). */
export async function launchDuck(launch: Launch): Promise<void> {
  const composer = $<HTMLTextAreaElement>("duck-text");
  switch (launch) {
    case "talk":
      panel = "tap";
      openDuck();
      return;
    case "chat":
      openDuck();
      composer.focus();
      return;
    case "task":
      fresh = true;
      openDuck();
      composer.value = TASK_LEAD;
      fitComposer();
      composer.focus();
      return;
    case "status":
      pendingAsk = STATUS_ASK;
      openDuck();
      return;
    case "share": {
      const s = await takeShare();
      shared = s && shareBody(s) ? { body: shareBody(s), preview: shareLines(s).join("\n") } : null;
      // Files shared (G1) are staged like a 📎 pick; within 10 s of a voice turn
      // they go with it (G2), in its thread.
      const files = s?.files ?? [];
      const turn = !shared && files.length ? lastVoice() : null;
      if (turn) turnFiles.resume(turn.at, lateTo(turn.threadId));
      if (files.length) stageFiles(files);
      fresh = !turn && (shared !== null || files.length > 0);
      openDuck();
      if (!shared && !files.length) {
        view = { ...view, error: "Nothing came with the share, or it was too old." };
        paint("share");
      }
      return;
    }
    case "share-lost":
      openDuck();
      view = { ...view, error: "The share didn't reach Duck: the app wasn't ready for it. Open the app once, then share again." };
      paint("share");
  }
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
  seen = loadSeen();
  duckApp.initApp({
    post,
    live: () => ws?.readyState === WebSocket.OPEN,
    listen: listenOnce,
    talk: talkFromApp,
    open: () => openDuck(),
    pushed: (to) => {
      if (to.threadId) openDuck(to.threadId);
      else if (to.instanceId) deps.console(to.instanceId);
    },
    talkStopped: (why) => {
      if (talk || talkStarting) {
        post({ type: "conv.stop" });
        endTalk(`Conversation mode ${why}.`);
      }
    },
    note: setVoiceNote,
  });
  if (duckApp.inApp()) {
    void getAppSettings().then((s) => (appSettings = s)).catch(() => {});
    $("duck-app-address").onclick = () => void saveAddress(null).then(() => location.replace(LOADER_URL));
    for (const b of document.querySelectorAll<HTMLButtonElement>("#duck-unlock [data-unlock]"))
      b.onclick = () =>
        void setAppSettings({ requireUnlock: b.dataset.unlock === "true" }).then((s) => {
          appSettings = s;
          paint("prefs");
        });
    void phoneBrainLine();
    $("duck-phone-key-save").onclick = () => {
      const box = $<HTMLInputElement>("duck-phone-key");
      void setPhoneKey(box.value.trim() || null)
        .then(() => {
          box.value = "";
          return phoneBrainLine();
        })
        .catch((e: unknown) => ($("duck-phone-brain").textContent = e instanceof Error ? e.message : String(e)));
    };
  }
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
  // G1: 📎, and pasted files.
  const picker = $<HTMLInputElement>("duck-file");
  $("duck-attach").onclick = () => picker.click();
  // G5: the sketch pad.
  $("duck-sketch").onclick = () => openSketch(sketchHooks());
  picker.onchange = () => {
    stageFiles(Array.from(picker.files ?? []).map((f) => ({ blob: f, name: f.name || "photo.jpg" })));
    picker.value = "";
  };
  text.addEventListener("paste", (e) => {
    const files = Array.from(e.clipboardData?.files ?? []);
    if (!files.length) return;
    e.preventDefault();
    stageFiles(files.map((f) => ({ blob: f, name: pastedName(f) })));
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

  // R3: the tap-to-talk screen, a share's quick asks, installing.
  $("duck-tap-btn").onclick = () => {
    panel = "chat";
    paint("panel");
    void startTalk();
  };
  $("duck-tap-skip").onclick = () => {
    panel = "chat";
    paint("panel");
    $("duck-text").focus();
  };
  const asks = $("duck-share-asks");
  for (const a of SHARE_ASKS) {
    const b = el("button", "", a.label);
    b.type = "button";
    b.onclick = () => sendShare(a.ask, false);
    asks.append(b);
  }
  $("duck-share-drop").onclick = () => {
    shared = null;
    paintShare();
  };
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault(); // the settings and the hint offer it instead of the browser's bar
    installPrompt = e as Event & { prompt(): Promise<void> };
    paint("install");
  });
  window.addEventListener("appinstalled", () => {
    installPrompt = null;
    paint("install");
  });
  const install = () => {
    if (installPrompt) void installPrompt.prompt().finally(() => (installPrompt = null));
    else {
      panel = "settings";
      paint("panel");
    }
  };
  $("duck-home-install").onclick = install;
  $("duck-install-go").onclick = install;
  $("duck-install-close").onclick = () => {
    store(INSTALL_HINT_KEY, "1");
    paintInstall();
  };

  document.addEventListener("visibilitychange", () => {
    if (!shown) return;
    if (document.hidden && talkAway()) {
      // The app's conversation mode goes on with the screen off (R4).
      stopAvatar();
    } else if (document.hidden) {
      cancelRecording();
      if (talk || talkStarting) stopTalk();
      hush();
      stopAvatar();
      disconnect();
    } else {
      connect();
      startAvatar();
      seeCurrent();
      paintUnread();
    }
  });
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.addEventListener("message", (e: MessageEvent<{ type?: string; threadId?: string }>) => {
      if (e.data?.type === "open-duck" && e.data.threadId) openDuck(e.data.threadId);
    });
  }
}
