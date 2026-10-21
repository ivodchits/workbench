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
//   rendered one at a time, in order, each told to that socket as `tts {part, id}`
//   as soon as it's made, so the phone plays sentence 1 while sentence 2 is made.
//   When the reply is complete (idle, or parked on a confirmation), `ttsEnd`. A
//   `speak` message also starts the voice engine, in case it went idle.
// - A confirmation that comes with no phone connected and the desktop not in front
//   of you is pushed to the phones.

import { z } from "zod";
import type { StoredMessage } from "../ipc/assistant";
import {
  assistantRemoteEmit,
  assistantRemotePush,
  onAssistantRemoteInput,
  type AssistantRemoteInput,
} from "../ipc/remote";
import type { RemoteDuckFrame, RemoteDuckMessage } from "../remote/protocol";
import { PROTOCOL_VERSION, type ClientMessage, type DuckEndpoint, type DuckEvent } from "./protocol";
import { langOf, Sentences, type Lang } from "./speakable";

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
  }),
  z.object({ type: z.literal("stop"), threadId: id }),
  z.object({ type: z.literal("confirm"), threadId: id, toolUseId: id, allow: z.boolean() }),
  z.object({ type: z.literal("trust.pause") }),
  z.object({ type: z.literal("trust.decisions"), before: z.number().int().nullable() }),
  z.object({ type: z.literal("task.close"), taskId: id }),
  z.object({ type: z.literal("task.rerun"), taskId: id }),
  z.object({ type: z.literal("autopilot"), instanceId: id, action: z.enum(["pause", "resume", "stop"]) }),
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
}

const stamp = (e: DuckEvent): RemoteDuckFrame => ({ ...e, v: PROTOCOL_VERSION });

/** Start relaying. Returns the stop. */
export function startRemoteBridge(d: BridgeDeps): () => void {
  const conns = new Set<number>();
  /** `speak` messages not yet seen stored: which socket, and the text stored. */
  const wanted: { conn: number; text: string }[] = [];
  /** Replies being spoken for a phone, by thread. */
  const speaking = new Map<string, Spoken>();
  const pushed = new Set<string>();
  let nextReply = 0;

  const toPhone = (conn: number, e: DuckEvent) => d.link.emit(stamp(e), conn);
  const live = (s: Spoken) => !s.stopped && conns.has(s.conn);

  function say(threadId: string, s: Spoken, sentence: string): void {
    const ready = d.prepare(sentence);
    s.chain = s.chain.then(async () => {
      const p = await ready;
      if (!p || !live(s)) return;
      try {
        const r = await d.render(p.text, p.lang);
        if (live(s))
          d.link.emit({ type: "tts", threadId, reply: s.reply, part: s.parts++, id: r.id, seconds: r.seconds, v: PROTOCOL_VERSION }, s.conn);
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
    void s.chain.then(() => {
      if (live(s)) d.link.emit({ type: "ttsEnd", threadId, reply: s.reply, parts: s.parts, v: PROTOCOL_VERSION }, s.conn);
    });
  }

  const offEvents = d.duck.onEvent((e) => {
    switch (e.type) {
      case "message": {
        const m = e.message;
        if (m.role !== "user") break;
        // A new turn: whatever was speaking here, you've moved on.
        const old = speaking.get(m.threadId);
        if (old) old.stopped = true;
        speaking.delete(m.threadId);
        const i = m.source.startsWith("phone") ? wanted.findIndex((w) => w.text === textOf(m)) : -1;
        if (i >= 0) {
          speaking.set(m.threadId, {
            conn: wanted[i].conn,
            reply: `r${++nextReply}`,
            cut: new Sentences(),
            chain: Promise.resolve(),
            parts: 0,
            stopped: false,
          });
          wanted.splice(i, 1);
        }
        break;
      }
      case "delta": {
        const s = speaking.get(e.threadId);
        if (s) for (const sentence of s.cut.push(e.text)) say(e.threadId, s, sentence);
        break;
      }
      case "turnState":
        if (e.state === "idle" || e.state === "waiting") finish(e.threadId);
        break;
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
    } else {
      const msg = parseRemote(i.msg, d.fixVoice);
      if (typeof msg === "string") return toPhone(i.conn, { type: "error", message: msg });
      const raw = i.msg as RemoteDuckMessage;
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

  return () => {
    offEvents();
    offInput();
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
