// The listen button: one message read aloud by Duck's reader (`reader.ts`)
// without asking Duck. On a session's messages in its transcript view (desktop
// and phone), keyed `msg:<instance>:<item>`, narrated for listening (code becomes
// what it does); and on Duck's own replies in its threads, keyed
// `duck:<thread>:<seq>:<part>`, read as written (Duck writes to be heard; a code
// block is "see the code on screen"). Either is a read like `read_aloud`'s, a
// section at a time, with the reader bar's pause, skip and stop, its place kept
// per message. It belongs to no Duck thread, so it starts at once (no reply to
// wait for) and a stop on its own leaves no notice anywhere.

import type { Item } from "../transcript/model";
import { CHARS_PER_MINUTE, NARRATE_SECTION, sections, VERBATIM_SECTION, type ReadJob, type ReaderView } from "./reader";

/** A message to read: where its place is kept, what the reader bar calls it, and
 *  its text (markdown as the session wrote it). */
export interface ListenRequest {
  key: string;
  title: string;
  text: string;
}

/** The longest text read (about 50 minutes), as `read_aloud`'s. */
export const LISTEN_MAX_TEXT = 45_000;
const TITLE_CHARS = 48;

/** The reads of `instanceId`'s messages have keys starting with this. */
export function listenPrefix(instanceId: string): string {
  return `msg:${instanceId}:`;
}

/** What the reader bar calls a message: who wrote it, and its first words. */
function titleOf(who: string, text: string): string {
  const line =
    text
      .split("\n")
      .map((l) => l.replace(/^[#>*`\s-]+/, "").trim())
      .find(Boolean) ?? "";
  const words = line.length > TITLE_CHARS ? `${line.slice(0, TITLE_CHARS - 1).trimEnd()}…` : line;
  return words ? `${who}: ${words}` : who;
}

/** The request for one transcript item; null for items that have no button. */
export function listenRequest(instanceId: string, item: Item): ListenRequest | null {
  if (item.kind !== "assistant" && item.kind !== "user") return null;
  const text = item.text.trim();
  if (!text) return null;
  return {
    key: `${listenPrefix(instanceId)}${item.id}`,
    title: titleOf(item.kind === "user" ? "Your message" : "Claude", text),
    text: text.slice(0, LISTEN_MAX_TEXT),
  };
}

/** A listen key: a session message's or a Duck reply's. */
export const LISTEN_KEY = /^(msg|duck):\S{1,300}$/;

/** The request for one of Duck's replies in a thread (`key`: the drawer's item
 *  key, `<thread>:<seq>:<part>`); null when it has nothing to read. */
export function duckListenRequest(key: string, text: string): ListenRequest | null {
  const t = text.trim();
  if (!t) return null;
  return { key: `duck:${key}`, title: titleOf("Duck", t), text: t.slice(0, LISTEN_MAX_TEXT) };
}

/** The reader's job for a request: a session's message narrated, Duck's read as
 *  written. */
export function listenJob(req: ListenRequest): ReadJob {
  const text = req.text.slice(0, LISTEN_MAX_TEXT);
  const narrate = !req.key.startsWith("duck:");
  return {
    key: req.key,
    title: req.title,
    sections: sections(text, narrate ? NARRATE_SECTION : VERBATIM_SECTION),
    narrate,
    threadId: "",
    // All of it: the button asked for this one message.
    maxChars: 60 * CHARS_PER_MINUTE,
    // "Continue reading" (Duck's tool) can read it again as text.
    source: { source: "text", text, title: req.title, mode: narrate ? "narrate" : "verbatim" },
  };
}

/** What a click on a message's button does, given what the reader is doing. */
export function listenAction(view: ReaderView | null, key: string): "stop" | "resume" | "read" {
  if (view?.key !== key) return "read";
  return view.state === "reading" ? "stop" : "resume";
}

/** How the reader is on the message keyed `key`: null when it's not reading it. */
export function listenStateOf(view: ReaderView | null, key: string): "reading" | "paused" | null {
  return view?.key === key ? view.state : null;
}

/** The message `view` is reading of `instanceId`'s, by item id; null when none. */
export function listeningTo(view: ReaderView | null, instanceId: string): { itemId: string; state: "reading" | "paused" } | null {
  const prefix = listenPrefix(instanceId);
  if (!view?.key.startsWith(prefix)) return null;
  return { itemId: view.key.slice(prefix.length), state: view.state };
}
