// The phone's transcript view (step R4) — the conversation half of the console
// overlay (`console.ts`), and what it opens on.
//
// The desktop's own pieces do the work: `transcript/feed` joins history to the live
// stream and `transcript/render` draws it, here over the `/api/transcript` socket
// (`transcriptSource`). This module is the chrome: scrolling that sticks to the end,
// "load earlier", the status line, the choice card (step R5) — or, when the desktop
// can't say what is asked, the needs-you row — and the composer, which sends the
// dashboard's ordinary `prompt` action, with any pictures and files attached by 📎
// or a paste (`sessionFiles`), and voice messages by 🎤: recorded as Duck's mic
// does (`mic`), transcribed by the desktop's model (`/api/assistant/audio`), and
// put in the field to check and send — never sent unseen.
//
// Offline first: the tail of each session's transcript is kept on the phone
// (`transcriptCache`), so a console opens on it at once and the socket resumes
// after it; unsent text is kept per session across reloads; and a prompt that
// couldn't go waits in the outbox, shown under the conversation until it does.

import { sizeText } from "../assistant/attachments";
import { fixNames } from "../assistant/voiceNames";
import type { RemoteInstance } from "../remote/protocol";
import { createFeed, type Feed } from "../transcript/feed";
import { createRenderer, markListening, type TranscriptRenderer } from "../transcript/render";
import { attachMediaViewer } from "../transcript/media";
import { listenPrefix, listenRequest, listeningTo } from "../assistant/listen";
import type { ReaderView } from "../assistant/reader";
import { controlReader, listenOnPhone, onReader, paintReaderBar } from "./duck";
import { createChoiceCard, type ChoiceCardView } from "./choice";
import { releaseDuckMic } from "./duck";
import { $, el } from "./dom";
import { phaseOf } from "./format";
import { pastedName, readyImage, SESSION_IMAGE_MAX } from "./images";
import { createStaging, promptWith, uploadToSession } from "./sessionFiles";
import { outbox } from "./link";
import { micAvailable, MAX_SECONDS, record, type Recording } from "./mic";
import { action, api, ApiError, openSocket, ready } from "./net";
import { clock, joinDictation } from "../util/dictation";
import type { OutboxItem } from "./outbox";
import { drop, load, save, saver } from "./store";
import { valid, type TranscriptCache } from "./transcriptCache";
import { transcriptSource } from "./transcriptSource";

/** Closer than this to the end counts as "at the bottom". */
const STICK_PX = 48;
/** The composer grows with its text up to this share of the screen. */
const COMPOSER_MAX_VH = 0.35;

let current: string | null = null;
let feed: Feed | null = null;
let renderer: TranscriptRenderer | null = null;
/** The reader was at the end as of their last scroll. */
let stuck = true;
let live: RemoteInstance | undefined;
/** Unsent text per instance, kept while the overlay is closed or switched, and
 *  on the device across reloads. */
const drafts = {
  key: (id: string) => `wb-tx-draft:${id}`,
  get(id: string): string | undefined {
    try {
      return localStorage.getItem(this.key(id)) ?? undefined;
    } catch {
      return undefined;
    }
  },
  set(id: string, text: string): void {
    try {
      localStorage.setItem(this.key(id), text);
    } catch {
      // no storage: kept while the page is open, in the field
    }
  },
  delete(id: string): void {
    try {
      localStorage.removeItem(this.key(id));
    } catch {
      // nothing kept
    }
  },
};

// ── the kept tails ──

/** Sessions whose tails are kept, at most; the least recently seen go first. */
const TAILS_MAX = 12;
const TAIL_INDEX = "tx-index";
const tailKey = (id: string) => `tx:${id}`;
const tailSavers = new Map<string, (c: TranscriptCache) => void>();

function keepTail(id: string): (c: TranscriptCache) => void {
  let fn = tailSavers.get(id);
  if (!fn) {
    const write = saver(tailKey(id), 2000);
    fn = (c) => {
      write(c);
      void noteTail(id, c.at);
    };
    tailSavers.set(id, fn);
  }
  return fn;
}

/** Record that `id`'s tail was kept now, and let the oldest tails go. */
async function noteTail(id: string, at: number): Promise<void> {
  const index = { ...((await load<Record<string, number>>(TAIL_INDEX)) ?? {}), [id]: at };
  const old = Object.entries(index)
    .sort((a, b) => b[1] - a[1])
    .slice(TAILS_MAX);
  for (const [gone] of old) {
    delete index[gone];
    void drop(tailKey(gone));
  }
  await save(TAIL_INDEX, index);
}
let onLink: (text: string) => void = () => {};
/** The feed's connection state, as last reported. */
let linkText = "";
let switchToTerminal: () => void = () => {};
let card: ChoiceCardView | null = null;
/** Pictures and files waiting for each instance's next prompt. */
const staging = createStaging(uploadToSession, (id) => {
  if (id === current) paintFiles();
});

/** What Duck's reader is doing, as last heard. */
let reader: ReaderView | null = null;
let noteTimer: ReturnType<typeof setTimeout> | null = null;
/** How long a listen button's "can't" stays up. */
const LISTEN_NOTE_MS = 6000;

/** The listen buttons and the reader bar, for the message of this session being
 *  read (if one is). */
function paintListening(): void {
  const mine = current ? listeningTo(reader, current) : null;
  if (renderer) markListening($("tx-list"), mine);
  paintReaderBar($("tx-reader"), current && reader?.key.startsWith(listenPrefix(current)) ? reader : null);
}

function listenNote(text: string | null): void {
  const note = $("tx-listen-note");
  note.textContent = text ?? "";
  note.classList.toggle("hidden", !text);
  if (noteTimer) clearTimeout(noteTimer);
  noteTimer = text ? setTimeout(() => listenNote(null), LISTEN_NOTE_MS) : null;
}

function scroller(): HTMLElement {
  return $("tx-scroll");
}

function atBottom(): boolean {
  const s = scroller();
  return s.scrollHeight - s.scrollTop - s.clientHeight < STICK_PX;
}

function toEnd(): void {
  const s = scroller();
  s.scrollTop = s.scrollHeight;
}

function setAway(away: boolean): void {
  $("tx-jump").classList.toggle("hidden", !away);
}

/** Repaint after the feed changed, keeping the reader's place. */
function changed(why: string): void {
  if (!feed || !renderer) return;
  const s = scroller();
  const follow = why === "reset" || stuck;
  const height = s.scrollHeight;
  const top = s.scrollTop;
  if (why !== "loading") {
    renderer.update(feed.items);
    paintListening();
  }
  const earlier = $<HTMLButtonElement>("tx-earlier");
  earlier.classList.toggle("hidden", !feed.hasEarlier);
  earlier.disabled = feed.loading;
  earlier.textContent = feed.loading ? "loading…" : "↑ load earlier";
  const empty = $("tx-empty");
  empty.classList.toggle("hidden", feed.items.length > 0);
  empty.textContent = !feed.ready || feed.loading ? "loading…" : "nothing in this session yet";
  if (follow) toEnd();
  else if (why === "prepend") s.scrollTop = top + (s.scrollHeight - height);
  stuck = follow;
  setAway(!follow);
}

/** The status line, the needs-you row and the composer's buttons, from the latest
 *  snapshot of the instance. */
function paintStatus(): void {
  const it = live;
  const phase = it ? phaseOf(it) : "idle";
  const status = $("tx-status");
  if (it?.compacting) {
    status.className = "working";
    status.textContent = "◐ compacting…";
  } else if (phase === "working") {
    status.className = "working";
    const n = it?.subagents ?? 0;
    status.textContent = `◐ working${n > 0 ? ` · ${n} subagent${n === 1 ? "" : "s"}` : ""}`;
  } else {
    status.className = "";
    status.textContent = "";
  }
  const choice = phase === "needs_you" ? (it?.choice ?? null) : null;
  card?.update(choice);
  $("tx-needs").classList.toggle("hidden", phase !== "needs_you" || choice !== null);
  $("tx-stop").classList.toggle("hidden", phase !== "working");
  const running = it?.live ?? false;
  const text = $<HTMLTextAreaElement>("tx-text");
  text.placeholder = running ? "message Claude…" : "session not running";
  $("tx-send").textContent = running ? "send" : "start";
  // An SSH session's folder is on the other machine.
  $("tx-attach").classList.toggle("hidden", it?.remote ?? false);
  if (stuck) toEnd();
}

/** The staged files' chips, and send held while some are still going up. */
function paintFiles(): void {
  const box = $("tx-files");
  const items = current ? staging.list(current) : [];
  box.replaceChildren(
    ...items.map((s) => {
      const chip = el("span", `duck-file${s.state === "failed" ? " failed" : ""}`);
      if (s.preview) {
        const img = document.createElement("img");
        img.src = s.preview;
        img.alt = "";
        chip.append(img);
      } else chip.append(el("span", "sign", "📄"));
      chip.append(el("span", "name", s.name));
      if (s.state === "adding") chip.append(el("span", "size", "adding…"));
      else if (s.state === "failed") chip.append(el("span", "error", s.error ?? "failed"));
      else chip.append(el("span", "size", sizeText(s.size)));
      const x = el("button", "", "✕");
      x.type = "button";
      x.setAttribute("aria-label", `remove ${s.name}`);
      x.onclick = () => {
        if (current) staging.remove(current, s.key);
      };
      chip.append(x);
      return chip;
    }),
  );
  box.classList.toggle("hidden", items.length === 0);
  const busy = current ? staging.busy(current) : false;
  const sendBtn = $<HTMLButtonElement>("tx-send");
  sendBtn.disabled = busy;
  sendBtn.title = busy ? "waiting for the files to go up" : "";
  if (stuck) toEnd();
}

/** Stage files for the open instance; a picture is readied first (`images`). */
function attach(files: { blob: Blob; name: string }[]): void {
  const id = current;
  if (!id) return;
  for (const f of files)
    void readyImage(f.blob, f.name, SESSION_IMAGE_MAX).then((r) => {
      const picture = r.blob.type.startsWith("image/") && r.blob.type !== "image/svg+xml";
      staging.add(id, r.blob, r.name, picture ? URL.createObjectURL(r.blob) : undefined);
    });
}

/** Grow the composer with its text, up to a cap; past it, it scrolls. */
function fitComposer(): void {
  const text = $<HTMLTextAreaElement>("tx-text");
  text.style.height = "auto";
  text.style.height = `${Math.min(text.scrollHeight + 2, window.innerHeight * COMPOSER_MAX_VH)}px`;
}

function send(): void {
  if (!current) return;
  const text = $<HTMLTextAreaElement>("tx-text");
  if (!live?.live) {
    // Nowhere for a prompt to go yet; the desktop would start the console and drop
    // the text. Start it, and keep the text for when it is up.
    action({ type: "start", instanceId: current });
    return;
  }
  const body = text.value.trim();
  const files = staging.list(current).some((s) => s.state === "ready");
  if (!body && !files) return;
  if (staging.busy(current)) return; // send is held until they're up
  action({ type: "prompt", instanceId: current, text: promptWith(body, staging.take(current)) });
  text.value = "";
  drafts.delete(current);
  fitComposer();
  // The prompt will appear at the end: go there.
  stuck = true;
  setAway(false);
  toEnd();
}

// ── voice messages ──

/** The recording, while it runs, and the session it's for. */
let rec: { recording: Recording; id: string } | null = null;
let voicePhase: "idle" | "starting" | "recording" | "transcribing" = "idle";
let voiceError: { id: string; text: string } | null = null;
let voiceTimer: ReturnType<typeof setInterval> | null = null;

function paintVoice(): void {
  const box = $("tx-voice");
  const line = $("tx-voice-text");
  const mic = $<HTMLButtonElement>("tx-mic");
  const recording = voicePhase === "recording";
  mic.classList.toggle("on", recording);
  mic.textContent = recording ? "■" : "🎤";
  mic.setAttribute("aria-label", recording ? "stop and transcribe" : "record a voice message");
  mic.disabled = voicePhase === "starting" || voicePhase === "transcribing";
  const error = voiceError && voiceError.id === current ? voiceError.text : null;
  box.classList.toggle("error", voicePhase === "idle" && !!error);
  $("tx-voice-cancel").textContent = voicePhase === "idle" ? "✕" : "cancel";
  $("tx-voice-cancel").classList.toggle("hidden", voicePhase === "transcribing");
  if (voicePhase === "starting") line.textContent = "opening the mic…";
  else if (recording) {
    const s = rec?.recording.seconds() ?? 0;
    const cap = s >= MAX_SECONDS - 10 ? ` (stops at ${clock(MAX_SECONDS)})` : "";
    line.replaceChildren(el("span", "dot", "●"), ` recording ${clock(s)}${cap} · ■ puts the text in the field`);
  } else if (voicePhase === "transcribing") line.textContent = "transcribing…";
  else line.textContent = error ?? "";
  box.classList.toggle("hidden", voicePhase === "idle" && !error);
  if (stuck) toEnd();
}

function stopVoiceTimer(): void {
  if (voiceTimer) clearInterval(voiceTimer);
  voiceTimer = null;
}

async function startVoice(): Promise<void> {
  const id = current;
  if (!id || voicePhase !== "idle") return;
  if (!micAvailable()) {
    voiceError = {
      id,
      text: "Voice messages need the mic, which this page can't have here: open it at its https address, or in Duck's app.",
    };
    paintVoice();
    return;
  }
  voiceError = null;
  voicePhase = "starting";
  paintVoice();
  releaseDuckMic();
  try {
    const recording = await record(() => void finishVoice());
    // TS narrows `voicePhase` from before the await; `cancelVoice` may have run.
    if ((voicePhase as string) !== "starting" || current !== id) {
      recording.cancel(); // cancelled, or the overlay closed, while the mic opened
      return;
    }
    rec = { recording, id };
    voicePhase = "recording";
    voiceTimer = setInterval(paintVoice, 500);
  } catch (e) {
    voicePhase = "idle";
    voiceError = {
      id,
      text:
        e instanceof DOMException && e.name === "NotAllowedError"
          ? "The mic was refused. Allow it for this site (or for Duck's app) in the phone's settings."
          : e instanceof DOMException && e.name === "NotFoundError"
            ? "There's no mic to record with."
            : e instanceof Error && e.message.startsWith("The mic was refused")
              ? e.message // Duck's app's own refusal (`DuckPlugin.kt`)
              : `The mic didn't start: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
  paintVoice();
}

/** Stop, transcribe on the desktop, and put the text in that session's draft. */
async function finishVoice(): Promise<void> {
  const r = rec;
  if (!r || voicePhase !== "recording") return;
  rec = null;
  stopVoiceTimer();
  voicePhase = "transcribing";
  paintVoice();
  const fail = (text: string) => {
    voicePhase = "idle";
    voiceError = { id: r.id, text };
    paintVoice();
  };
  const wav = await r.recording.stop();
  if (!wav) return fail("Too short to hear.");
  let text: string;
  try {
    ({ text } = await api<{ text: string; ms: number }>("/api/assistant/audio", {
      query: { for: "session" },
      raw: wav,
      type: "audio/wav",
    }));
  } catch (e) {
    return fail(e instanceof ApiError ? `Couldn't transcribe: ${e.message}` : "Couldn't reach Workbench to transcribe.");
  }
  if (!text.trim()) return fail("Nothing was heard.");
  // English names said in Russian come out in Cyrillic: Duck's name fixer puts
  // this session's and project's names, and common terms, back.
  text = fixNames(text, live && r.id === live.id ? [live.projectName, live.title] : []).text;
  voicePhase = "idle";
  if (r.id === current) {
    const field = $<HTMLTextAreaElement>("tx-text");
    field.value = joinDictation(field.value, text);
    drafts.set(r.id, field.value);
    fitComposer();
    field.focus();
    field.setSelectionRange(field.value.length, field.value.length);
  } else drafts.set(r.id, joinDictation(drafts.get(r.id) ?? "", text));
  paintVoice();
}

/** Drop a recording (or the problem shown). */
function cancelVoice(): void {
  if (voicePhase === "recording" || voicePhase === "starting") {
    rec?.recording.cancel();
    rec = null;
    stopVoiceTimer();
    voicePhase = "idle";
  } else if (voicePhase === "idle") voiceError = null;
  paintVoice();
}

function report(text: string): void {
  linkText = text;
  onLink(text);
}

/** Show an instance's conversation. Keeps running while the terminal is shown
 *  instead, so switching back is instant. */
export function showTranscript(id: string, it: RemoteInstance | undefined): void {
  live = it;
  if (current !== id) {
    hideTranscript();
    current = id;
    stuck = true;
    renderer = createRenderer($("tx-list"), { listen: true });
    listenNote(null);
    report("connecting…");
    const text = $<HTMLTextAreaElement>("tx-text");
    text.value = drafts.get(id) ?? "";
    fitComposer();
    paintFiles();
    paintPending();
    paintVoice();
    // The kept tail first, if there is one: shown at once, resumed after.
    void load<unknown>(tailKey(id)).then((kept) => {
      if (current !== id || feed) return;
      const source = transcriptSource(id, {
        open: (params) => openSocket("/api/transcript", params),
        onLink: (up) => report(up ? "● live" : "○ reconnecting…"),
        ready,
        cache: { initial: valid(kept) ? kept : null, save: keepTail(id) },
      });
      feed = createFeed(source, changed);
      changed("reset");
    });
  } else {
    onLink(linkText); // back from the terminal: say where the feed stands
  }
  paintStatus();
}

/** A new snapshot of the shown instance. */
export function updateTranscript(it: RemoteInstance | undefined): void {
  if (!current) return;
  live = it;
  paintStatus();
}

/** Stop the feed and clear the view (the overlay closed). */
export function hideTranscript(): void {
  // The overlay closing (or another session opening) drops a recording.
  if (voicePhase === "recording" || voicePhase === "starting") cancelVoice();
  if (current) {
    const text = $<HTMLTextAreaElement>("tx-text").value;
    if (text.trim()) drafts.set(current, text);
    else drafts.delete(current);
  }
  feed?.stop();
  feed = null;
  card?.update(null);
  renderer?.clear();
  renderer = null;
  current = null;
  paintListening();
  $("tx-pending").replaceChildren();
}

/** The prompts to the open session still waiting in the outbox, under the
 *  conversation: retry or discard one that failed (its text goes back to the
 *  composer, never away). */
function paintPending(): void {
  const box = $("tx-pending");
  const items = current ? outbox.find("prompt", (it) => it.instanceId === current) : [];
  box.replaceChildren(...items.map(pendingRow));
  box.classList.toggle("hidden", items.length === 0);
  if (stuck) toEnd();
}

function pendingRow(it: Extract<OutboxItem, { kind: "prompt" }>): HTMLElement {
  const row = el("div", `pending ${it.state}`);
  row.append(el("div", "text", it.text));
  const label =
    it.state === "failed" ? `✗ not sent — ${it.error ?? "refused"}` : it.state === "sending" ? "⟳ sending…" : "⧗ waiting to send";
  const foot = el("div", "foot");
  foot.append(el("span", "state", label));
  if (it.state === "failed" || it.state === "pending") {
    if (it.state === "failed") {
      const again = el("button", "", "retry");
      again.type = "button";
      again.onclick = () => outbox.retry(it.id);
      foot.append(again);
    }
    const back = el("button", "", "edit");
    back.type = "button";
    back.title = "take it back into the composer";
    back.onclick = () => {
      const text = $<HTMLTextAreaElement>("tx-text");
      text.value = text.value.trim() ? `${text.value}\n${it.text}` : it.text;
      if (current) drafts.set(current, text.value);
      outbox.remove(it.id);
      fitComposer();
      text.focus();
    };
    foot.append(back);
  }
  row.append(foot);
  return row;
}

/** Wire the view's controls. `link` shows its connection state; `terminal` switches
 *  the overlay to the mirrored terminal. */
export function initTranscript(link: (text: string) => void, terminal: () => void): void {
  onLink = link;
  switchToTerminal = terminal;
  const s = scroller();
  // A picture's thumbnail opens the viewer over the transcript (improvement plan S1).
  attachMediaViewer(s, $("tx-view"));
  s.addEventListener(
    "scroll",
    () => {
      stuck = atBottom();
      setAway(!stuck);
    },
    { passive: true },
  );
  // The keyboard opening (or the composer growing) shrinks the view; a reader at
  // the end stays there.
  new ResizeObserver(() => {
    if (stuck) toEnd();
  }).observe(s);
  // Rendered links are untrusted text: web and mail links open in a new tab, as the
  // renderer marked them; nothing else goes anywhere.
  s.addEventListener("click", (e) => {
    // A message's listen button: read it aloud here, or stop / go on with it.
    const listen = e.target instanceof Element ? e.target.closest(".wb-tx-listen") : null;
    if (listen) {
      e.preventDefault();
      e.stopPropagation();
      const id = listen.closest<HTMLElement>("[data-item-id]")?.dataset.itemId;
      const item = feed?.items.find((i) => i.id === id);
      const req = item && current ? listenRequest(current, item) : null;
      if (req) {
        listenNote(null);
        listenOnPhone(req, listenNote);
      }
      return;
    }
    const link = e.target instanceof Element ? e.target.closest("a[href]") : null;
    if (link && !/^(https?:|mailto:)/i.test(link.getAttribute("href") ?? "")) e.preventDefault();
  });
  $("tx-earlier").onclick = () => void feed?.loadEarlier();
  for (const b of document.querySelectorAll<HTMLButtonElement>("#tx-reader [data-reader]"))
    b.onclick = () => controlReader(b.dataset.reader ?? "");
  onReader((r) => {
    reader = r;
    paintListening();
  });
  outbox.subscribe(paintPending);
  $("tx-jump").onclick = () => {
    stuck = true;
    setAway(false);
    toEnd();
  };
  const text = $<HTMLTextAreaElement>("tx-text");
  text.addEventListener("input", () => {
    fitComposer();
    if (current) drafts.set(current, text.value);
  });
  // Enter is a new line, as on any phone keyboard; the button sends. A hardware
  // keyboard can send with Ctrl/⌘+Enter.
  text.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      send();
    }
  });
  const send_ = $("tx-send");
  // Tapping send must not close the on-screen keyboard: a follow-up is often next.
  send_.addEventListener("pointerdown", (e) => {
    if (document.activeElement === text) e.preventDefault();
  });
  send_.onclick = send;
  const mic = $("tx-mic");
  // Like send, the mic mustn't close the on-screen keyboard.
  mic.addEventListener("pointerdown", (e) => {
    if (document.activeElement === text) e.preventDefault();
  });
  mic.onclick = () => {
    if (voicePhase === "recording") void finishVoice();
    else void startVoice();
  };
  $("tx-voice-cancel").onclick = cancelVoice;
  const picker = $<HTMLInputElement>("tx-file");
  $("tx-attach").onclick = () => picker.click();
  picker.onchange = () => {
    attach(Array.from(picker.files ?? []).map((f) => ({ blob: f, name: f.name || "photo.jpg" })));
    picker.value = "";
  };
  // A pasted picture (or file) is attached; pasted text is left to the field.
  text.addEventListener("paste", (e) => {
    const files = Array.from(e.clipboardData?.files ?? []);
    if (!files.length) return;
    e.preventDefault();
    attach(files.map((f) => ({ blob: f, name: pastedName(f) })));
  });
  $("tx-stop").onclick = () => {
    if (current) action({ type: "interrupt", instanceId: current });
  };
  for (const type of ["approve", "deny"] as const) {
    $(`tx-${type}`).onclick = () => {
      if (current) action({ type, instanceId: current });
    };
  }
  $("tx-answer").onclick = () => switchToTerminal();
  card = createChoiceCard(false, {
    choose: (choiceId, option) => {
      if (current) action({ type: "choose", instanceId: current, choiceId, option });
    },
    terminal: () => switchToTerminal(),
  });
  $("tx-choice").replaceWith(card.root);
  card.root.id = "tx-choice";
}
