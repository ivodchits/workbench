// The phone's fallback brain (step H7), the parts both sides share. When
// Workbench can't be reached, Duck's app runs the engine on the phone
// (`src/pwa/phoneBrain.ts`) with only the phone's tools and reminders, on its own
// API key. What it made comes to the desktop when the app's page next connects
// (`offline.sync`, `remoteBridge.ts`):
//
// - Reminders by id: one the desktop already has is left as it is.
// - Each conversation as a thread of its own, its title marked offline: your
//   messages and Duck's replies as text, a line for each tool Duck used. A thread
//   the desktop already has (same id) isn't made again.
//
// The desktop answers `offline.synced` with what it took, and the phone drops
// those.

import { z } from "zod";
import type { StoredMessage, ThreadRow } from "../ipc/assistant";
import { USER_SOURCES } from "./protocol";

/** Added to the system prompt on the phone: what's different there. */
export const OFFLINE_NOTE = `

You're running on the user's phone right now, as Duck's offline brain: Workbench (the desktop) can't be reached. Only the phone's tools and the reminders work here: no sessions, projects, notes, music search, web or memory. Say so in a few words when asked for one of those, and that it can wait until Workbench is back. Reminders you add here ring on the phone and go to Workbench when it's back. Keep replies short: they're read aloud by the phone's voice.`;

/** A conversation's title on the desktop. */
export const OFFLINE_TITLE = (title: string) => `Offline: ${title}`;

export interface OfflineMessage {
  role: "user" | "assistant";
  text: string;
  /** Epoch ms. */
  at: number;
  /** Your message was spoken. */
  voice?: boolean;
}

export interface OfflineThread {
  id: string;
  title: string;
  messages: OfflineMessage[];
}

const TEXT_MAX = 20_000;
const id = z.string().min(1).max(200);

/** A reminder as the phone sends it: the desktop's record, checked loosely (the
 *  reminders' own code checks the rest). */
const Reminder = z
  .object({
    id,
    title: z.string().min(1).max(200),
    state: z.enum(["open", "done", "dismissed"]),
    created: z.string().max(40),
  })
  .passthrough();

export const OfflineSync = z.object({
  type: z.literal("offline.sync"),
  reminders: z.array(Reminder).max(200),
  threads: z
    .array(
      z.object({
        id,
        title: z.string().max(200),
        messages: z
          .array(
            z.object({
              role: z.enum(["user", "assistant"]),
              text: z.string().max(TEXT_MAX),
              at: z.number(),
              voice: z.boolean().optional(),
            }),
          )
          .max(500),
      }),
    )
    .max(50),
});

/** One stored message's words: its text blocks, and a line per tool call. */
function wordsOf(m: StoredMessage): string {
  if (typeof m.content === "string") return m.content;
  if (!Array.isArray(m.content)) return "";
  const out: string[] = [];
  for (const b of m.content as { type?: string; text?: string; name?: string }[]) {
    if (b.type === "text" && b.text) out.push(b.text);
    else if (b.type === "tool_use" && b.name) out.push(`[used ${b.name}]`);
  }
  return out.join("\n");
}

/** A thread's conversation as the desktop takes it: your messages and Duck's
 *  replies, a turn's rounds joined, tool results, system messages, notices and
 *  events left out. It ends with a reply, so the desktop can carry it on. */
export function transcript(history: readonly StoredMessage[]): OfflineMessage[] {
  const out: OfflineMessage[] = [];
  for (const m of history) {
    let role: OfflineMessage["role"];
    if (m.role === "assistant") role = "assistant";
    else if (m.role === "user" && USER_SOURCES.has(m.source)) role = "user";
    else continue;
    const text = wordsOf(m).trim();
    if (!text) continue;
    const last = out[out.length - 1];
    if (last?.role === role) last.text += `\n\n${text}`;
    else out.push({ role, text, at: m.ts, ...(m.source.endsWith("voice") && { voice: true }) });
  }
  if (out.length && out[out.length - 1].role === "user")
    out.push({ role: "assistant", text: "[No reply: the phone's brain didn't answer this.]", at: out[out.length - 1].at });
  for (const m of out) m.text = m.text.slice(0, TEXT_MAX);
  return out;
}

// ── what the phone keeps ──

/** The phone brain's threads as the app keeps them (`offline_put("threads")`). */
export interface OfflineState {
  threads: { row: ThreadRow; messages: StoredMessage[] }[];
  pending: { id: string; threadId: string; data: unknown }[];
}

export const EMPTY_STATE: OfflineState = { threads: [], pending: [] };

export function parseState(json: string | null): OfflineState {
  try {
    const s = json ? (JSON.parse(json) as OfflineState) : null;
    return s && Array.isArray(s.threads) && Array.isArray(s.pending) ? s : EMPTY_STATE;
  } catch {
    return EMPTY_STATE;
  }
}

/** A thread's title: its own, or its first words. */
function titleOf(t: { row: ThreadRow }, messages: OfflineMessage[]): string {
  if (t.row.title.trim()) return t.row.title.trim();
  const first = messages.find((m) => m.role === "user")?.text.replace(/\s+/g, " ").trim() ?? "";
  return first.length > 60 ? `${first.slice(0, 59)}…` : first || "a conversation";
}

/** The conversations to send the desktop: those with anything said. */
export function threadsToSync(s: OfflineState): OfflineThread[] {
  return s.threads.flatMap((t) => {
    const messages = transcript(t.messages);
    return messages.length ? [{ id: t.row.id, title: titleOf(t, messages), messages }] : [];
  });
}

/** `s` without the threads the desktop took (or that had nothing to take). */
export function withoutThreads(s: OfflineState, took: readonly string[], empty: readonly string[] = []): OfflineState {
  const gone = new Set([...took, ...empty]);
  return { threads: s.threads.filter((t) => !gone.has(t.row.id)), pending: s.pending.filter((p) => !gone.has(p.threadId)) };
}
