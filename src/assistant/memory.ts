// Duck's long-term memory (step L1), the engine's side. The memory is markdown in
// the workspace's `memory/` (a file per topic, one dated entry per bullet), with an
// FTS index in `duck.db` that also covers the project notes, read-only; the Rust
// side (`assistant/memory.rs`) keeps the index and commits every change.
//
// Two ways it comes back:
// - **Automatic recall.** Before a turn, your message is searched (SQLite, no model
//   call). Up to `RECALL_K` hits that hold enough of its words go in a system note
//   after it, turn-scoped (`clear_at: "next_user_message"`): the model sees them
//   for this reply only, the note stays in the history as sent (so the cache and
//   the thinking hold), and it costs nothing once the next message comes.
// - **On purpose,** with `recall`.
//
// A message that reads like a correction ("no, I meant…", «не то») gets a line in
// the same note asking Duck to save the lesson.

import type { Notice } from "./protocol";
import type { StoredMessage } from "../ipc/assistant";
import {
  memoryForget,
  memoryMatching,
  memorySearch,
  memoryWrite,
  type MemoryEntry,
  type MemoryFileEdit,
  type MemoryHit,
  type NewMemoryEntry,
} from "../ipc/memory";

export const MEMORY_TOPICS = ["decisions", "preferences", "people", "goals", "lessons"] as const;

export interface MemoryHost {
  search(query: string, k: number): Promise<MemoryHit[]>;
  write(topic: string, entry: NewMemoryEntry): Promise<{ edit: MemoryFileEdit | null; entry: MemoryEntry }>;
  /** The entries holding every word of `query`. */
  matching(query: string): Promise<MemoryEntry[]>;
  forget(entries: { file: string; raw: string }[], message: string): Promise<MemoryFileEdit[]>;
}

/** The host over Duck's workspace (the settings' folder, else the default). */
export function createMemoryHost(workspace: () => string | null): MemoryHost {
  return {
    search: (query, k) => memorySearch(workspace(), query, k),
    write: (topic, entry) => memoryWrite(workspace(), topic, entry),
    matching: (query) => memoryMatching(workspace(), query),
    forget: (entries, message) => memoryForget(workspace(), entries, message),
  };
}

/** Hits automatic recall adds to a turn, at most. */
export const RECALL_K = 3;
/** How long a turn waits for its recall before going on without it. */
export const RECALL_MS = 1500;
/** The longest message searched whole; a longer one by its start. */
const RECALL_QUERY_CHARS = 2000;

/** The hits worth showing unasked: a memory entry holding two of the message's
 *  words (its one, for a one-word message), a note three (notes are longer, so
 *  they match more by chance). */
export function worthRecalling(hits: readonly MemoryHit[]): MemoryHit[] {
  return hits
    .filter((h) => (h.kind === "memory" ? h.matched >= Math.min(2, h.terms) : h.terms >= 2 && h.matched >= Math.min(3, h.terms)))
    .slice(0, RECALL_K);
}

/** "No, I meant…", «не то»: a message that corrects Duck. */
export function isCorrection(text: string): boolean {
  const t = text.trim().toLowerCase();
  return (
    /^(no|nope|wrong|not that|not quite|that's not|that is not|that isn't)\b/.test(t) ||
    /\b(i meant|i said|i didn't (mean|ask|say)|not what i (asked|meant|said)|you misunderstood|don't do that again)\b/.test(t) ||
    /^(нет|не то|не так|неправильно|неверно|не надо)(?=$|[\s,.!?:;—-])/.test(t) ||
    /(^|[\s,.!?«"(])(не то[,.!?»"]|не то$|я имела? в виду|я же (сказал|сказала|просил|просила)|ты не понял|ты не поняла|я не это)/.test(t)
  );
}

/** One hit as a line of the note. */
function hitLine(h: MemoryHit): string {
  if (h.kind === "note") return `- [${h.label}] ${h.text.replace(/\s+/g, " ")} (${h.path})`;
  const e = h.entry;
  const meta = [h.label, e?.date, e?.conf && `conf ${e.conf}`].filter(Boolean).join(", ");
  return `- [${meta}] ${h.text}${e?.src ? ` (src: ${e.src})` : ""}`;
}

export const RECALL_OPEN = "<recalled_memories>";

const LESSON_LINE =
  "The user's message reads like a correction. If you got something wrong about what they mean or how they like things done, save the lesson with remember (topic lessons): the mistake and the right behavior, in one line.";

/** The turn-scoped note for a message: what was recalled and, for a correction,
 *  the lesson line. Null when there's neither. */
export function recallNote(hits: readonly MemoryHit[], correction: boolean): string | null {
  if (!hits.length && !correction) return null;
  const parts: string[] = [];
  if (hits.length)
    parts.push(
      `${RECALL_OPEN}\nPossibly relevant, from your long-term memory and the user's notes. Found by keyword, so some may not apply: use what helps, without saying you looked it up.\n${hits.map(hitLine).join("\n")}\n</recalled_memories>`,
    );
  if (correction) parts.push(LESSON_LINE);
  return parts.join("\n\n");
}

/** The note for a message, or null; a search that fails or is slow is left out. */
export async function recallFor(host: MemoryHost | undefined, text: string): Promise<string | null> {
  const correction = isCorrection(text);
  let hits: MemoryHit[] = [];
  if (host) {
    const found = host.search(text.slice(0, RECALL_QUERY_CHARS), RECALL_K * 3).catch((e) => {
      console.warn("duck: recall failed", e);
      return [];
    });
    const late = new Promise<MemoryHit[]>((resolve) => setTimeout(() => resolve([]), RECALL_MS));
    hits = worthRecalling(await Promise.race([found, late]));
  }
  return recallNote(hits, correction);
}

/** Whether you asked Duck not to remember this thread: its latest `memoryOff`
 *  notice says. */
export function memoryOff(history: readonly StoredMessage[]): boolean {
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i];
    const n = m.role === "notice" ? (m.content as Notice | null) : null;
    if (n?.kind === "memoryOff") return n.off ?? true;
  }
  return false;
}

/** The local date, `YYYY-MM-DD`. */
export function today(now = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}
