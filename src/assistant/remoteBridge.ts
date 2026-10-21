// Duck on the phone (step R1): the webview's half of the remote server's
// `/api/assistant` socket (`src-tauri/src/remote/assistant.rs`). Duck runs here, so
// the server only relays.
//
// - Up: a socket opening, each of its frames, and its closing arrive as
//   `assistant-remote-input`. A frame is checked against what a phone may do
//   (`RemoteDuckMessage`) and handed to Duck; the answers to it (`threads`,
//   `history`, an error…) go back to that socket only.
// - Down: Duck's events go to every socket while one is open.
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

import { z } from "zod";
import type { StoredMessage } from "../ipc/assistant";
import {
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

/** The longest message a phone may send. */
const TEXT_MAX = 20_000;

const id = z.string().min(1).max(200);
const Message = z.discriminatedUnion("type", [
  z.object({ type: z.literal("sync") }),
  z.object({ type: z.literal("thread.open"), threadId: id }),
  z.object({ type: z.literal("thread.new") }),
  z.object({
    type: z.literal("send"),
    threadId: id.nullable(),
    text: z.string().trim().min(1).max(TEXT_MAX),
    voice: z.boolean().optional(),
    speak: z.boolean().optional(),
    effort: z.enum(["low", "medium", "high", "xhigh", "max"]).optional(),
    provisional: z.boolean().optional(),
  }),
  z.object({ type: z.literal("stop"), threadId: id }),
  z.object({ type: z.literal("turn.commit"), threadId: id }),
  z.object({ type: z.literal("turn.withdraw"), threadId: id }),
  z.object({ type: z.literal("confirm"), threadId: id, toolUseId: id, allow: z.boolean() }),
  z.object({ type: z.literal("trust.pause") }),
  z.object({ type: z.literal("trust.decisions"), before: z.number().int().nullable() }),
  z.object({ type: z.literal("task.close"), taskId: id }),
  z.object({ type: z.literal("task.rerun"), taskId: id }),
  z.object({ type: z.literal("autopilot"), instanceId: id, action: z.enum(["pause", "resume", "stop"]) }),
  z.object({ type: z.literal("reader"), action: z.enum(["pause", "resume", "next", "prev", "stop"]) }),
  z.object({ type: z.literal("dnd"), until: z.number().int().positive().nullable() }),
]);

/** A phone's frame as a Duck Protocol message, or why it's refused. */
export function parseRemote(raw: unknown, fixVoice: (text: string) => string): ClientMessage | string {
  const type = (raw as { type?: unknown } | null)?.type;
  const r = Message.safeParse(raw);
  if (!r.success) return typeof type === "string" ? `"${type}" can't be sent from the phone` : "not a Duck message";
  const m: RemoteDuckMessage = r.data;
  switch (m.type) {
    case "send":
      return {
        type: "send",
        threadId: m.threadId,
        text: m.voice ? fixVoice(m.text) : m.text,
        source: m.voice ? "phone-voice" : "phone",
        ...(m.effort && { effort: m.effort }),
        ...(m.provisional && { provisional: true }),
      };
    case "trust.pause":
      return { type: "trust.pause", paused: true };
    default:
      return m;
  }
}

/** The text of a stored user message. */
function textOf(m: StoredMessage): string {
  return Array.isArray(m.content)
    ? (m.content as { type?: string; text?: string }[])
        .filter((b) => b.type === "text")
        .map((b) => b.text ?? "")
        .join("\n")
    : String(m.content);
}

/** The server's side, as the bridge sees it. */
export interface RemoteLink {
  onInput(cb: (i: AssistantRemoteInput) => void): () => void;
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
        if (conns.size === 0 && !pushed.has(r.toolUseId) && !d.watching()) {
          pushed.add(r.toolUseId);
          d.link.push(r.threadId, "Duck is waiting for a yes or no", r.summary ?? `It wants to use ${r.name}.`);
        }
        break;
      }
    }
    if (conns.size > 0) d.link.emit(stamp(e), null);
  });

  const offInput = d.link.onInput((i) => {
    if (i.kind === "open") conns.add(i.conn);
    else if (i.kind === "close") {
      conns.delete(i.conn);
      for (let k = wanted.length - 1; k >= 0; k--) if (wanted[k].conn === i.conn) wanted.splice(k, 1);
      for (let k = sent.length - 1; k >= 0; k--) if (sent[k].conn === i.conn) sent.splice(k, 1);
    } else {
      const msg = parseRemote(i.msg, d.fixVoice);
      if (typeof msg === "string") return toPhone(i.conn, { type: "error", message: msg });
      const raw = i.msg as RemoteDuckMessage;
      if (msg.type === "send") sent.push({ conn: i.conn, text: msg.text });
      if (msg.type === "send" && raw.type === "send" && raw.speak) {
        wanted.push({ conn: i.conn, text: msg.text });
        d.warm(langOf(msg.text) === "ru");
      }
      if (msg.type === "stop") {
        const s = speaking.get(msg.threadId);
        if (s) s.stopped = true;
      }
      d.duck.handle(msg, (e) => toPhone(i.conn, e));
    }
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
    },
    async quiet(threadId) {
      while (speaking.has(threadId)) await new Promise((r) => setTimeout(r, 100));
      await tails.get(threadId);
    },
    phones: () => conns.size,
    announce(text, threadId) {
      const reply = `news${++nextReply}`;
      const to = [...conns];
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
  emit(frame, conn) {
    void assistantRemoteEmit(frame, conn).catch(() => {});
  },
  push(threadId, title, body) {
    void assistantRemotePush(threadId, title, body).catch(() => {});
  },
};
