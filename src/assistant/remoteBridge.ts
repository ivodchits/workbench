// Duck on the phone (step R1): the webview's half of the remote server's
// `/api/assistant` socket (`src-tauri/src/remote/assistant.rs`). Duck runs here, so
// the server only relays.
//
// - Up: a socket opening, each of its frames, and its closing arrive as
//   `assistant-remote-input`. A frame is checked against what a phone may do
//   (`RemoteDuckMessage`) and handed to Duck; the answers to it (`threads`,
//   `history`, an error…) go back to that socket only.
// - Down: Duck's events go to every socket while one is open. A bridge that starts
//   with sockets already open (the webview reloaded) asks the server for them.
// - What a phone may not do, over an address that may be public: change Duck's
//   settings, loosen trust (rules, modes, the floor, resuming after a pause), run
//   the replay, or delete a thread. It can pause trust.
// - Its messages are stored as `phone`, or `phone-voice` when dictated: the names
//   are fixed as for the desktop's voice, the reply is written to be heard, and
//   the desktop doesn't speak it.
// - `speak`: the reply is cut into sentences as it streams, made speakable and
//   rendered one at a time, in order, each told to that socket as `tts {part, id, text}`
//   as soon as it's made, so the phone plays sentence 1 while sentence 2 is made.
//   When the reply is complete (idle, or parked on a confirmation), `ttsEnd`. A
//   `speak` message also starts the voice engine, in case it went idle. With
//   nothing to say `ACK_MS` after the message, a stock "One moment." is.
// - A confirmation that comes with no phone connected and the desktop not in front
//   of you is pushed to the phones.
// - Read-aloud (step V3): a read asked for from a phone plays there
//   (`voiceFor`), as `tts` parts like a reply's, a section at a time; `ttsCut`
//   drops what the phone still has queued when the read is paused or skipped.
// - Images (screenshots) never go to the phone: a line stands in for each.
// - Announcements (step V5) for a phone with Duck open come as `tts` parts of a
//   `news…` reply, to every open phone; the phone's own "speak" setting decides
//   whether it plays them.
// - Conversation mode on the phone (step V4 part 3): its turns come as
//   `provisional` sends, then `turn.commit` or `turn.withdraw`. A provisional
//   turn's reply is spoken as it streams, as a committed one's is; withdrawn, what
//   the phone still has queued is cut (`ttsCut`).
// - Duck moving a phone's conversation (step A7, `goThread`): when the reply that
//   moved it was spoken for a phone, the reply to the words it brought over is
//   spoken for that phone too.
// - A socket can also be a host (step H1, `hosts.ts`): its `hello` and
//   `device.result` frames go to the hosts, not to Duck, and the calls come down
//   to it as `device.call` / `device.cancel`. Over this socket only the phone can
//   be a host: the PC's tools are the desktop's own.
// - The phone's app as a host (step H5) gets the open reminders' coming times
//   (`phone.reminders`, on hello and on every change) and arms them as exact
//   alarms, which ring with the desktop unreachable. Its Done and Snooze come
//   back as `reminder.action`, from a socket that said hello only.
// - What the app's offline brain made (step H7, `offline.ts`) comes as
//   `offline.sync`, from a socket that said hello only; `offline.synced` tells it
//   what was taken.
// - Files (step G1) go up as `attach.chunk` parts and are stored (`attach`);
//   `attached` gives the phone the file to send. A `send` names its files by id,
//   and only files uploaded here count: the rest of each (name, path) is the
//   desktop's own record, never the phone's word.
// - The office's Duck chat (office plan O3.1) comes over this bridge too, as the
//   device `office`: a page on this PC, so its messages are the desktop's (no
//   dictation, nothing spoken for it), and it's not a phone: confirmations are still
//   pushed with only offices open, and announcements aren't said there.

import { withoutManifest } from "./voiceFiles";
import { z } from "zod";
import type { StoredFile, StoredMessage } from "../ipc/assistant";
import { MAX_ATTACHMENTS, type AttachmentRef } from "./attachments";
import {
  assistantRemoteConns,
  assistantRemoteEmit,
  assistantRemotePush,
  onAssistantRemoteInput,
  type AssistantRemoteInput,
} from "../ipc/remote";
import type { RemoteDuckFrame, RemoteDuckMessage } from "../remote/protocol";
import { PROTOCOL_VERSION, USER_SOURCES, type ClientMessage, type DuckEndpoint, type DuckEvent } from "./protocol";
import { sentencesOf, type Spoken as Ready, type Voice } from "./reader";
import { langOf, Sentences, type Lang } from "./speakable";
import { withoutImages } from "./threads";
import { isHostUp, type HostConn, type Hosts } from "./hosts";
import type { PhoneAlarm, ReminderRecord } from "./reminders";
import { OfflineSync, type OfflineThread } from "./offline";

/** The longest message a phone may send. */
const TEXT_MAX = 20_000;
/** The biggest file a phone may send, as base64 (about 25 MB). */
const UPLOAD_MAX = 34_000_000;
/** One part of an upload, as base64 (the server takes frames up to 256 KB). */
const PART_MAX = 200 * 1024;
/** Files uploaded, remembered for the messages that send them. */
const UPLOADS_KEPT = 200;

const id = z.string().min(1).max(200);
const Message = z.discriminatedUnion("type", [
  z.object({ type: z.literal("sync") }),
  z.object({ type: z.literal("thread.open"), threadId: id }),
  z.object({ type: z.literal("thread.new") }),
  z.object({
    type: z.literal("send"),
    threadId: id.nullable(),
    text: z.string().trim().max(TEXT_MAX),
    voice: z.boolean().optional(),
    speak: z.boolean().optional(),
    effort: z.enum(["low", "medium", "high", "xhigh", "max"]).optional(),
    provisional: z.boolean().optional(),
    attachments: z.array(id).max(MAX_ATTACHMENTS).optional(),
  }),
  z.object({ type: z.literal("stop"), threadId: id }),
  z.object({ type: z.literal("turn.commit"), threadId: id }),
  z.object({ type: z.literal("turn.withdraw"), threadId: id }),
  z.object({ type: z.literal("turn.files"), threadId: id, attachments: z.array(id).min(1).max(MAX_ATTACHMENTS) }),
  z.object({ type: z.literal("confirm"), threadId: id, toolUseId: id, allow: z.boolean(), choice: z.string().max(64).optional() }),
  z.object({ type: z.literal("trust.pause") }),
  z.object({ type: z.literal("trust.decisions"), before: z.number().int().nullable() }),
  z.object({ type: z.literal("task.close"), taskId: id }),
  z.object({ type: z.literal("task.rerun"), taskId: id }),
  z.object({ type: z.literal("autopilot"), instanceId: id, action: z.enum(["pause", "resume", "stop"]) }),
  z.object({ type: z.literal("reader"), action: z.enum(["pause", "resume", "next", "prev", "stop"]) }),
  z.object({ type: z.literal("dnd"), until: z.number().int().positive().nullable() }),
  z.object({ type: z.literal("drawing.get"), drawingId: id }),
  z.object({ type: z.literal("canvas"), drawingId: id.nullable() }),
]);

/** What the office may not send: it's no host, and it uploads nothing. */
const OFFICE_REFUSED = new Set<unknown>(["hello", "device.result", "reminder.action", "offline.sync", "attach.chunk"]);

/** Frames only a host sends, besides `hello` and results. */
const HOST_ONLY = new Set<unknown>(["reminder.action", "offline.sync"]);

const HostFrame = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("hello"),
    host: z.literal("phone"),
    tools: z.array(z.string().max(64)).max(200),
    version: z.number().int(),
  }),
  z.object({ type: z.literal("device.result"), id, ok: z.boolean(), output: z.unknown() }),
  z.object({ type: z.literal("reminder.action"), id, action: z.enum(["done", "snooze"]) }),
  OfflineSync,
]);

const Chunk = z.object({
  type: z.literal("attach.chunk"),
  upload: id,
  name: z.string().trim().min(1).max(200),
  part: z.number().int().min(0),
  data: z.string().max(PART_MAX).regex(/^[A-Za-z0-9+/]*={0,2}$/),
  last: z.boolean(),
});

/** The device the office's sockets come as (`src-tauri/src/remote/office.rs`). */
export const OFFICE_DEVICE = "office";

/** A phone's frame as a Duck Protocol message, or why it's refused. `file`
 *  finds a file uploaded here (step G1). `office`: it's the office's, on this PC. */
export function parseRemote(
  raw: unknown,
  fixVoice: (text: string) => string,
  file: (id: string) => AttachmentRef | undefined = () => undefined,
  office = false,
): ClientMessage | string {
  const type = (raw as { type?: unknown } | null)?.type;
  const r = Message.safeParse(raw);
  if (!r.success) return typeof type === "string" ? `"${type}" can't be sent from the phone` : "not a Duck message";
  const m: RemoteDuckMessage = r.data;
  switch (m.type) {
    case "send": {
      const files = (m.attachments ?? []).map(file);
      if (!m.text && !files.length) return "an empty message";
      if (files.some((f) => !f)) return "a file in this message wasn't uploaded here: attach it again";
      return {
        type: "send",
        threadId: m.threadId,
        text: m.voice && !office ? fixVoice(m.text) : m.text,
        source: office ? "desktop" : m.voice ? "phone-voice" : "phone",
        ...(m.effort && { effort: m.effort }),
        ...(m.provisional && { provisional: true }),
        ...(files.length && { attachments: files as AttachmentRef[] }),
      };
    }
    case "turn.files": {
      // Files shared just after a spoken turn (step G2).
      const files = m.attachments.map(file);
      if (files.some((f) => !f)) return "a file in this message wasn't uploaded here: attach it again";
      return { type: "turn.files", threadId: m.threadId, attachments: files as AttachmentRef[], source: "phone-voice" };
    }
    case "trust.pause":
      return { type: "trust.pause", paused: true };
    case "canvas":
      return { type: "canvas", surface: office ? "desktop" : "phone", drawingId: m.drawingId };
    default:
      return m;
  }
}

/** The text of a stored user message. */
function textOf(m: StoredMessage): string {
  return Array.isArray(m.content)
    ? withoutManifest(m.content as { type?: string; text?: string }[])
        .filter((b) => b.type === "text")
        .map((b) => b.text ?? "")
        .join("\n")
    : String(m.content);
}

/** The server's side, as the bridge sees it. */
export interface RemoteLink {
  onInput(cb: (i: AssistantRemoteInput) => void): () => void;
  /** The sockets already open (the webview reloaded under them). */
  open?(): Promise<{ conn: number; device: string }[]>;
  emit(frame: RemoteDuckFrame, conn: number | null): void;
  push(threadId: string, title: string, body: string): void;
}

export interface BridgeDeps {
  duck: DuckEndpoint;
  link: RemoteLink;
  /** The desktop is in front of you: a confirmation there will be seen. */
  watching(): boolean;
  /** A dictated message with its names fixed (`voiceMessage`). */
  fixVoice(text: string): string;
  /** A sentence made speakable (`prepareSentence`), or null when nothing in it can be said. */
  prepare(sentence: string): Promise<{ text: string; lang: Lang } | null>;
  /** A speakable sentence as audio for the phone. */
  render(text: string, lang: Lang): Promise<{ id: string; seconds: number }>;
  /** Start the voice engine (with Russian too) if it isn't running. */
  warm(ru: boolean): void;
  /** Where a socket that says `hello` connects as a host (step H1). */
  hosts?: Hosts;
  /** The reminders a phone host arms as alarms (step H5). */
  phoneReminders?: PhoneReminders;
  /** Takes what a phone's offline brain made (step H7): the ids taken. */
  offline?: (reminders: ReminderRecord[], threads: OfflineThread[]) => Promise<{ reminders: string[]; threads: string[] }>;
  /** Stores a file a phone uploaded (step G1), given as base64. */
  attach?: (name: string, data: string) => Promise<StoredFile>;
}

/** What a phone host gets of the reminders (step H5). */
export interface PhoneReminders {
  /** The open reminders' coming times. */
  alarms(): PhoneAlarm[];
  /** Hear every change. */
  subscribe(cb: () => void): () => void;
  /** The phone's Done or Snooze, tapped on its own notification. */
  act(id: string, action: "done" | "snooze"): void;
}

/** A reply being spoken for a phone. */
interface Spoken {
  conn: number;
  reply: string;
  cut: Sentences;
  /** Sentences are rendered in order: each waits for the one before. */
  chain: Promise<void>;
  parts: number;
  stopped: boolean;
  /** A sentence of it was queued. */
  said: boolean;
  /** The reply to a provisional turn, not kept yet: the message it answers. */
  provisional: string | null;
}

/** A spoken reply with nothing to say this long after the message gets a stock
 *  acknowledgement, so the phone knows it was heard. */
export const ACK_MS = 3500;

/** A read's next section is started this long before the phone runs out. */
const READ_LEAD_MS = 1500;

/** An event as the phone gets it: no images. */
function forPhone(e: DuckEvent): DuckEvent {
  if (e.type === "message") return { ...e, message: { ...e.message, content: withoutImages(e.message.content) } };
  if (e.type === "history") return { ...e, messages: e.messages.map((m) => ({ ...m, content: withoutImages(m.content) })) };
  return e;
}

const stamp = (e: DuckEvent): RemoteDuckFrame => ({ ...forPhone(e), v: PROTOCOL_VERSION });

export interface RemoteBridge {
  stop(): void;
  /** A voice on the phone that sent `threadId`'s latest message, while it's
   *  connected; null when that message came from the desktop. */
  voiceFor(threadId: string): Voice | null;
  /** Resolves once `threadId`'s reply has been sent to the phone whole. */
  quiet(threadId: string): Promise<void>;
  /** Phones with Duck open now. */
  phones(): number;
  /** Say an announcement on every phone with Duck open. */
  announce(text: string, threadId: string): void;
}

/** Start relaying. */
export function startRemoteBridge(d: BridgeDeps): RemoteBridge {
  const conns = new Set<number>();
  /** The sockets that are the office's, not phones. */
  const offices = new Set<number>();
  const phones = () => conns.size - offices.size;
  /** Messages phones sent, not yet seen stored. */
  const sent: { conn: number; text: string }[] = [];
  /** The phone that sent each thread's latest message of yours. */
  const lastConn = new Map<string, number>();
  /** `speak` messages not yet seen stored: which socket, and the text stored. */
  const wanted: { conn: number; text: string }[] = [];
  /** Replies being spoken for a phone, by thread. */
  const speaking = new Map<string, Spoken>();
  /** The phone each thread's latest reply was spoken for. */
  const spokeFor = new Map<string, number>();
  /** Threads Duck moved a phone's conversation into: the next message of yours
   *  there is spoken for that phone. */
  const follow = new Map<string, number>();
  const pushed = new Set<string>();
  /** Each thread's last reply spoken for a phone, until all of it is sent. */
  const tails = new Map<string, Promise<void>>();
  let nextReply = 0;
  /** Sockets that are hosts (H1). */
  const hostConns = new Map<number, HostConn>();

  const toPhone = (conn: number, e: DuckEvent) => d.link.emit(stamp(e), conn);
  const live = (s: Spoken) => !s.stopped && conns.has(s.conn);

  function say(threadId: string, s: Spoken, sentence: string): void {
    s.said = true;
    const ready = d.prepare(sentence);
    s.chain = s.chain.then(async () => {
      const p = await ready;
      if (!p || !live(s)) return;
      try {
        const r = await d.render(p.text, p.lang);
        if (live(s))
          d.link.emit(
            { type: "tts", threadId, reply: s.reply, part: s.parts++, id: r.id, seconds: r.seconds, text: p.text, v: PROTOCOL_VERSION },
            s.conn,
          );
      } catch (err) {
        if (live(s))
          toPhone(s.conn, { type: "error", message: `Couldn't speak the reply: ${err instanceof Error ? err.message : String(err)}` });
        s.stopped = true;
      }
    });
  }

  function finish(threadId: string): void {
    const s = speaking.get(threadId);
    if (!s) return;
    speaking.delete(threadId);
    for (const sentence of s.cut.end()) say(threadId, s, sentence);
    tails.set(threadId, s.chain);
    void s.chain.then(() => {
      if (tails.get(threadId) === s.chain) tails.delete(threadId);
      if (live(s)) d.link.emit({ type: "ttsEnd", threadId, reply: s.reply, parts: s.parts, v: PROTOCOL_VERSION }, s.conn);
    });
  }

  /** A message of yours came in `threadId` (stored, or a provisional turn's):
   *  whatever was speaking there, you've moved on. A phone's message it asked to
   *  be spoken starts the speaking of its reply. */
  function yours(threadId: string, text: string, source: string, provisional: boolean): void {
    const k = source.startsWith("phone") ? sent.findIndex((w) => w.text === text) : -1;
    if (k >= 0) {
      lastConn.set(threadId, sent[k].conn);
      sent.splice(k, 1);
    } else lastConn.delete(threadId);
    const old = speaking.get(threadId);
    if (old) old.stopped = true;
    speaking.delete(threadId);
    const i = source.startsWith("phone") ? wanted.findIndex((w) => w.text === text) : -1;
    const moved = source.startsWith("phone") ? follow.get(threadId) : undefined;
    follow.delete(threadId);
    const conn = i >= 0 ? wanted[i].conn : moved;
    if (conn === undefined) spokeFor.delete(threadId);
    else {
      spokeFor.set(threadId, conn);
      if (i < 0) lastConn.set(threadId, conn);
      const s: Spoken = {
        conn,
        reply: `r${++nextReply}`,
        cut: new Sentences(),
        chain: Promise.resolve(),
        parts: 0,
        stopped: false,
        said: false,
        provisional: provisional ? text : null,
      };
      speaking.set(threadId, s);
      setTimeout(() => {
        if (speaking.get(threadId) === s && !s.said && live(s)) say(threadId, s, "One moment.");
      }, ACK_MS);
      if (i >= 0) wanted.splice(i, 1);
    }
  }

  const offEvents = d.duck.onEvent((e) => {
    switch (e.type) {
      case "message": {
        const m = e.message;
        // A message of yours (not a tool's results, which are stored as the user's
        // too).
        if (m.role !== "user" || !USER_SOURCES.has(m.source)) break;
        // A provisional turn that stood: its reply is already being spoken.
        const s = speaking.get(m.threadId);
        if (s?.provisional === textOf(m)) {
          s.provisional = null;
          break;
        }
        yours(m.threadId, textOf(m), m.source, false);
        break;
      }
      case "provisional":
        yours(e.threadId, e.text, e.source, true);
        break;
      case "withdrawn": {
        const s = speaking.get(e.threadId);
        if (s?.provisional != null) {
          s.stopped = true;
          speaking.delete(e.threadId);
          if (conns.has(s.conn)) d.link.emit({ type: "ttsCut", threadId: e.threadId, v: PROTOCOL_VERSION }, s.conn);
        }
        break;
      }
      case "delta": {
        const s = speaking.get(e.threadId);
        if (s) for (const sentence of s.cut.push(e.text)) say(e.threadId, s, sentence);
        break;
      }
      case "tool": {
        // What the reply has before a call ("Checking api.") is said now.
        const s = speaking.get(e.threadId);
        if (s && e.phase === "start") for (const sentence of s.cut.end()) say(e.threadId, s, sentence);
        break;
      }
      case "turnState":
        if (e.state === "idle" || e.state === "waiting") finish(e.threadId);
        break;
      case "goThread": {
        const conn = spokeFor.get(e.from);
        if (e.surface === "phone" && conn !== undefined && conns.has(conn)) follow.set(e.threadId, conn);
        break;
      }
      case "confirm": {
        const r = e.request;
        if (phones() === 0 && !pushed.has(r.toolUseId) && !d.watching()) {
          pushed.add(r.toolUseId);
          d.link.push(r.threadId, "Duck is waiting for a yes or no", r.summary ?? `It wants to use ${r.name}.`);
        }
        break;
      }
    }
    if (conns.size > 0) d.link.emit(stamp(e), null);
  });

  /** Uploads under way, by socket and upload id: the parts so far. */
  const uploads = new Map<string, { parts: string[]; size: number }>();
  /** Files phones uploaded, by id (the latest `UPLOADS_KEPT`). */
  const uploaded = new Map<string, AttachmentRef>();

  /** A part of a file from `conn` (step G1); the last stores it. */
  function chunk(conn: number, raw: unknown): void {
    const r = Chunk.safeParse(raw);
    const upload = (raw as { upload?: unknown } | null)?.upload;
    const answer = (f: { file?: AttachmentRef; error?: string }) =>
      d.link.emit({ type: "attached", upload: typeof upload === "string" ? upload : "", ...f, v: PROTOCOL_VERSION }, conn);
    if (!r.success) return answer({ error: "not a file part" });
    if (!d.attach) return answer({ error: "Duck takes no files here" });
    const m = r.data;
    const key = `${conn}:${m.upload}`;
    const u = uploads.get(key) ?? { parts: [], size: 0 };
    if (m.part !== u.parts.length) {
      uploads.delete(key);
      return answer({ error: "a part went missing: send the file again" });
    }
    u.parts.push(m.data);
    u.size += m.data.length;
    if (u.size > UPLOAD_MAX) {
      uploads.delete(key);
      return answer({ error: `over ${Math.round((UPLOAD_MAX * 3) / 4 / 1e6)} MB` });
    }
    if (!m.last) {
      uploads.set(key, u);
      return;
    }
    uploads.delete(key);
    d.attach(m.name, u.parts.join(""))
      .then((s) => {
        const file: AttachmentRef = { id: s.id, name: s.name, mime: s.mime, size: s.size, path: s.path, ...(s.thumb && { thumb: s.thumb }) };
        uploaded.delete(s.id);
        uploaded.set(s.id, file);
        while (uploaded.size > UPLOADS_KEPT) uploaded.delete(uploaded.keys().next().value!);
        answer({ file });
      })
      .catch((e: unknown) => answer({ error: e instanceof Error ? e.message : String(e) }));
  }

  /** Sockets that closed since this bridge started. */
  const closed = new Set<number>();
  // Sockets that opened before this bridge (the webview reloaded): theirs too.
  void d.link
    .open?.()
    .then((open) => {
      for (const o of open) {
        if (closed.has(o.conn)) continue;
        conns.add(o.conn);
        if (o.device === OFFICE_DEVICE) offices.add(o.conn);
      }
    })
    .catch(() => {});

  const offInput = d.link.onInput((i) => {
    if (i.kind === "open") {
      conns.add(i.conn);
      if (i.device === OFFICE_DEVICE) offices.add(i.conn);
    } else if (i.kind === "close") {
      closed.add(i.conn);
      conns.delete(i.conn);
      offices.delete(i.conn);
      for (const k of uploads.keys()) if (k.startsWith(`${i.conn}:`)) uploads.delete(k);
      hostConns.get(i.conn)?.close();
      hostConns.delete(i.conn);
      d.duck.handle({ type: "thread.view", surface: `phone:${i.conn}`, threadId: null });
      for (let k = wanted.length - 1; k >= 0; k--) if (wanted[k].conn === i.conn) wanted.splice(k, 1);
      for (let k = sent.length - 1; k >= 0; k--) if (sent[k].conn === i.conn) sent.splice(k, 1);
    } else if (offices.has(i.conn) && OFFICE_REFUSED.has((i.msg as { type?: unknown } | null)?.type)) {
      toPhone(i.conn, { type: "error", message: "not from the office" });
    } else if (isHostUp(i.msg) || HOST_ONLY.has((i.msg as { type?: unknown } | null)?.type)) {
      host(i.conn, i.msg);
    } else if ((i.msg as { type?: unknown } | null)?.type === "attach.chunk") {
      chunk(i.conn, i.msg);
    } else {
      const msg = parseRemote(i.msg, d.fixVoice, (fid) => uploaded.get(fid), offices.has(i.conn));
      if (typeof msg === "string") return toPhone(i.conn, { type: "error", message: msg });
      const raw = i.msg as RemoteDuckMessage;
      if (msg.type === "send") sent.push({ conn: i.conn, text: msg.text });
      if (msg.type === "send" && raw.type === "send" && raw.speak && !offices.has(i.conn)) {
        wanted.push({ conn: i.conn, text: msg.text });
        d.warm(langOf(msg.text) === "ru");
      }
      if (msg.type === "stop") {
        const s = speaking.get(msg.threadId);
        if (s) s.stopped = true;
      }
      // What the phone shows, for housekeeping (L4).
      if (msg.type === "thread.open" || (msg.type === "send" && msg.threadId))
        d.duck.handle({ type: "thread.view", surface: `phone:${i.conn}`, threadId: msg.threadId });
      d.duck.handle(msg, (e) => toPhone(i.conn, e));
    }
  });

  /** A host's frame from socket `conn` (H1). */
  function host(conn: number, raw: unknown): void {
    const refuse = (message: string) => toPhone(conn, { type: "error", message });
    if (!d.hosts) return refuse("Duck takes no hosts here");
    const r = HostFrame.safeParse(raw);
    if (!r.success) return refuse("not a host message, or not the phone's");
    const m = r.data;
    if (m.type === "device.result") {
      const c = hostConns.get(conn);
      return c ? c.receive(m) : refuse("say hello first");
    }
    if (m.type === "reminder.action") {
      if (!hostConns.has(conn)) return refuse("say hello first");
      if (!d.phoneReminders) return refuse("Duck has no reminders here");
      return d.phoneReminders.act(m.id, m.action);
    }
    if (m.type === "offline.sync") {
      if (!hostConns.has(conn)) return refuse("say hello first");
      if (!d.offline) return refuse("Duck takes nothing from the phone's offline brain here");
      d.offline(m.reminders as ReminderRecord[], m.threads)
        .then((took) => d.link.emit({ type: "offline.synced", ...took, v: PROTOCOL_VERSION }, conn))
        .catch((e: unknown) => refuse(`the offline sync failed: ${e instanceof Error ? e.message : String(e)}`));
      return;
    }
    hostConns.get(conn)?.close();
    hostConns.delete(conn);
    try {
      hostConns.set(conn, d.hosts.connect(m, (down) => d.link.emit({ ...down, v: PROTOCOL_VERSION }, conn)));
    } catch (e) {
      return refuse(e instanceof Error ? e.message : String(e));
    }
    sendAlarms(conn);
  }

  /** The reminders' coming times, to a phone host (H5). */
  function sendAlarms(conn: number): void {
    if (d.phoneReminders) d.link.emit({ type: "phone.reminders", alarms: d.phoneReminders.alarms(), v: PROTOCOL_VERSION }, conn);
  }
  const offReminders = d.phoneReminders?.subscribe(() => {
    for (const conn of hostConns.keys()) sendAlarms(conn);
  });

  /** A read's sections as `tts` parts to `conn`. */
  function phoneVoice(conn: number, threadId: string): Voice {
    let cut = 0;
    return {
      where: "phone",
      async play(sentences: Promise<Ready | null>[]) {
        const mine = cut;
        const reply = `read${++nextReply}`;
        const ok = () => mine === cut && conns.has(conn);
        let part = 0;
        /** When the phone will have played everything sent (an estimate). */
        let until = Date.now();
        for (const next of sentences) {
          const p = await next;
          if (!ok()) return false;
          if (!p) continue;
          const r = await d.render(p.text, p.lang);
          if (!ok()) return false;
          d.link.emit({ type: "tts", threadId, reply, part: part++, id: r.id, seconds: r.seconds, text: p.text, v: PROTOCOL_VERSION }, conn);
          until = Math.max(until, Date.now()) + r.seconds * 1000;
        }
        d.link.emit({ type: "ttsEnd", threadId, reply, parts: part, v: PROTOCOL_VERSION }, conn);
        const wait = until - Date.now() - READ_LEAD_MS;
        if (wait > 0) await new Promise((res) => setTimeout(res, wait));
        return ok();
      },
      cut() {
        cut++;
        if (conns.has(conn)) d.link.emit({ type: "ttsCut", threadId, v: PROTOCOL_VERSION }, conn);
      },
    };
  }

  return {
    stop() {
      offEvents();
      offInput();
      offReminders?.();
    },
    async quiet(threadId) {
      while (speaking.has(threadId)) await new Promise((r) => setTimeout(r, 100));
      await tails.get(threadId);
    },
    phones,
    announce(text, threadId) {
      const reply = `news${++nextReply}`;
      const to = [...conns].filter((c) => !offices.has(c));
      if (!to.length) return;
      void (async () => {
        let part = 0;
        for (const p of await Promise.all(sentencesOf(text).map((x) => d.prepare(x)))) {
          if (!p) continue;
          const r = await d.render(p.text, p.lang);
          for (const c of to)
            if (conns.has(c)) d.link.emit({ type: "tts", threadId, reply, part, id: r.id, seconds: r.seconds, text: p.text, v: PROTOCOL_VERSION }, c);
          part++;
        }
        for (const c of to) if (conns.has(c)) d.link.emit({ type: "ttsEnd", threadId, reply, parts: part, v: PROTOCOL_VERSION }, c);
      })().catch((e: unknown) => console.warn("duck: an announcement didn't reach the phone", e));
    },
    voiceFor(threadId) {
      const conn = lastConn.get(threadId);
      return conn !== undefined && conns.has(conn) ? phoneVoice(conn, threadId) : null;
    },
  };
}

/** The server's side over Tauri IPC. */
export const ipcLink: RemoteLink = {
  onInput(cb) {
    const off = onAssistantRemoteInput(cb);
    return () => void off.then((f) => f());
  },
  open: assistantRemoteConns,
  emit(frame, conn) {
    void assistantRemoteEmit(frame, conn).catch(() => {});
  },
  push(threadId, title, body) {
    void assistantRemotePush(threadId, title, body).catch(() => {});
  },
};
