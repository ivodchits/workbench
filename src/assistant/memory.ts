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
//
// Step L2: the same note carries a contradiction the nightly tidy found, as one
// question to ask you (`consolidate.ts`), and after the turn each recall is logged
// with what the reply used of it (`recallRow`), for the hit rate.

import type { Notice } from "./protocol";
import type { StoredMessage } from "../ipc/assistant";
import { recallLog, type RecallRow } from "../ipc/memory";
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
  /** Step L2: log an automatic recall. */
  log?(row: RecallRow): Promise<void>;
  /** Step L2: the next contradiction to ask about, marked asked; null for none. */
  question?(): Promise<string | null>;
  /** Step L2: tidy the memory now ("tidy your memory"). */
  tidy?(): Promise<TidyReport>;
  /** Step L3: a change to Duck to suggest (at most one a week), marked offered;
   *  null for none. */
  suggestion?(): Promise<string | null>;
  /** Step S2: a repeated request to offer as a skill (at most one a week),
   *  marked offered; null for none. */
  skillOffer?(): Promise<string | null>;
}

/** What a tidy did (step L2). */
export interface TidyReport {
  /** False when there was nothing new to read since the last one. */
  ran: boolean;
  added: number;
  merged: number;
  retired: number;
  questions: number;
  skills: number;
  journal: string | null;
  /** What it changed, a line each; and what it couldn't write. */
  log: string[];
  skipped: string[];
}

/** The host over Duck's workspace (the settings' folder, else the default). The
 *  app adds `question` and `tidy` once the consolidator is made. */
export function createMemoryHost(workspace: () => string | null): MemoryHost {
  return {
    search: (query, k) => memorySearch(workspace(), query, k),
    write: (topic, entry) => memoryWrite(workspace(), topic, entry),
    matching: (query) => memoryMatching(workspace(), query),
    forget: (entries, message) => memoryForget(workspace(), entries, message),
    log: recallLog,
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

/** The note's line for a contradiction the tidy found (step L2). */
export function questionLine(q: string): string {
  return `<memory_question>\nWhile tidying your memory you found entries that disagree. Ask the user this once, briefly, in your reply (after answering their message, if it asks something): ${q}\nWhen they answer, forget the entry that no longer holds and remember the one that does, if it isn't there already.\n</memory_question>`;
}

/** A change to Duck the tidy found a pattern for (step L3), to suggest once. */
export function suggestionLine(s: string): string {
  return `<duck_suggestion>\nWhile tidying your memory you noticed something you keep getting wrong, which a change to yourself could fix: ${s}\nMention it once, briefly, at a natural point in your reply, and offer to do it with improve_duck. Start it only if the user says yes.\n</duck_suggestion>`;
}

/** A request the tidy saw repeated (step S2), to offer once as a skill. */
export function skillOfferLine(s: string): string {
  return `<skill_suggestion>\nWhile tidying your memory you noticed a request the user keeps making: ${s}\nOffer once, briefly, at a natural point in your reply, to make it a skill so it goes the same way every time. Write it with draft_skill only if the user says yes.\n</skill_suggestion>`;
}

/** The turn-scoped note for a message: what was recalled, for a correction the
 *  lesson line, a contradiction to ask about, and a change to Duck or a skill to
 *  suggest. Null when there's none. */
export function recallNote(
  hits: readonly MemoryHit[],
  correction: boolean,
  question: string | null = null,
  suggestion: string | null = null,
  skillOffer: string | null = null,
): string | null {
  if (!hits.length && !correction && !question && !suggestion && !skillOffer) return null;
  const parts: string[] = [];
  if (hits.length)
    parts.push(
      `${RECALL_OPEN}\nPossibly relevant, from your long-term memory and the user's notes. Found by keyword, so some may not apply: use what helps, without saying you looked it up.\n${hits.map(hitLine).join("\n")}\n</recalled_memories>`,
    );
  if (correction) parts.push(LESSON_LINE);
  if (question) parts.push(questionLine(question));
  if (suggestion) parts.push(suggestionLine(suggestion));
  if (skillOffer) parts.push(skillOfferLine(skillOffer));
  return parts.join("\n\n");
}

/** A turn's automatic recall: the note, and what went into it, for the log. */
export interface Recall {
  note: string | null;
  query: string;
  /** Hits the search found, before the threshold. */
  candidates: number;
  hits: MemoryHit[];
}

/** Within `RECALL_MS`, or the fallback. */
function inTime<T>(p: Promise<T>, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<T>((resolve) => (timer = setTimeout(() => resolve(fallback), RECALL_MS)));
  return Promise.race([p, late]).finally(() => clearTimeout(timer));
}

/** The recall for a message; a search that fails or is slow is left out. */
export async function recallFor(host: MemoryHost | undefined, text: string): Promise<Recall> {
  const query = text.slice(0, RECALL_QUERY_CHARS);
  const correction = isCorrection(text);
  if (!host) return { note: recallNote([], correction), query, candidates: 0, hits: [] };
  const warn = (what: string) => (e: unknown) => {
    console.warn(`duck: ${what} failed`, e);
    return null;
  };
  // One offer a turn: a skill only when there's no change to Duck to suggest.
  const offer = async (): Promise<[string | null, string | null]> => {
    const s = host.suggestion ? await host.suggestion().catch(warn("the suggestion")) : null;
    if (s) return [s, null];
    return [null, host.skillOffer ? await host.skillOffer().catch(warn("the skill offer")) : null];
  };
  const [found, question, [suggestion, skillOffer]] = await Promise.all([
    inTime(host.search(query, RECALL_K * 3).catch(warn("recall")), null),
    host.question ? inTime(host.question().catch(warn("the memory question")), null) : null,
    inTime(offer(), [null, null] as [string | null, string | null]),
  ]);
  const hits = worthRecalling(found ?? []);
  return { note: recallNote(hits, correction, question, suggestion, skillOffer), query, candidates: found?.length ?? 0, hits };
}

// ── the recall log (step L2) ──

/** Words too common to say a hit was used. */
const COMMON = new Set(
  "that this with from have what when where which about there their they them then than been were will would could should into your yours just also only some more most very like such each other because while after before over under again still even here those these does done make made want need know think thing things time today tomorrow yesterday это этот эта эти того тогда когда если чтобы потому также только очень можно нужно будет было были есть него неё них свой своя свои который которая которые после перед сейчас сегодня завтра вчера".split(
    " ",
  ),
);

/** A text's words of four letters or more, cut as the index cuts them (a letter
 *  off a word of five or six, two off a longer one), so inflections match. */
export function stems(text: string): Set<string> {
  const out = new Set<string>();
  for (const w of text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) {
    if (w.length < 4 || COMMON.has(w) || /^\d+$/.test(w)) continue;
    out.add(w.length >= 7 ? w.slice(0, -2) : w.length >= 5 ? w.slice(0, -1) : w);
  }
  return out;
}

/** Whether a reply used a hit: it says two of the hit's own words (those not in
 *  the message it answers), or its one. A guess, for the hit rate. */
export function usedHit(hit: MemoryHit, query: string, reply: string): boolean {
  const asked = stems(query);
  const own = [...stems(`${hit.text} ${hit.entry?.tags ?? ""}`)].filter((s) => !asked.has(s));
  if (!own.length) return false;
  const r = reply.toLowerCase();
  return own.filter((s) => r.includes(s)).length >= Math.min(2, own.length);
}

/** The log row for a turn's recall, from the messages the turn added. */
export function recallRow(threadId: string, recall: Recall, turn: readonly StoredMessage[], at: number): RecallRow {
  let reply = "";
  let selfRecall = false;
  for (const m of turn) {
    if (m.role !== "assistant" || !Array.isArray(m.content)) continue;
    for (const b of m.content as { type?: string; text?: string; name?: string }[]) {
      if (b.type === "text") reply += `${b.text ?? ""}\n`;
      else if (b.type === "tool_use" && b.name === "recall") selfRecall = true;
    }
  }
  const hits = recall.hits.map((h) => ({
    label: h.label,
    file: h.file,
    line: h.line,
    matched: h.matched,
    terms: h.terms,
    used: usedHit(h, recall.query, reply),
  }));
  return {
    at,
    threadId,
    query: recall.query,
    candidates: recall.candidates,
    shown: hits.length,
    used: hits.filter((h) => h.used).length,
    selfRecall,
    hits,
  };
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
