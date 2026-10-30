// Duck on the phone while the desktop is away (`duck.ts`): its threads and their
// recent messages kept on the device, and the messages written meanwhile, which
// wait in the outbox (`outbox.ts`). Pure apart from types: tested on its own.
//
// What was kept seeds the view until Duck's socket syncs; then Duck's own frames
// replace it (`threads`, and `history` for each thread opened) — the desktop wins.
// A message from the outbox is delivered when Duck hands it back as a stored user
// message in that thread; one sent just as the link dropped is matched against
// the thread's history when it comes, so it isn't offered back needlessly.

import type { StoredMessage, ThreadRow } from "../ipc/assistant";
import type { DuckView } from "./duckStore";
import { userText } from "./duckStore";
import type { OutboxItem } from "./outbox";

export interface DuckCache {
  threads: ThreadRow[];
  current: string | null;
  /** The newest messages of the threads read most recently. */
  messages: Record<string, StoredMessage[]>;
  at: number;
}

/** Threads whose messages are kept, at most, and messages per thread. */
export const KEEP_THREADS = 15;
export const KEEP_MESSAGES = 60;

/** What to keep of `v`. */
export function cacheOf(v: DuckView, now = Date.now()): DuckCache {
  const messages: Record<string, StoredMessage[]> = {};
  // The threads list is newest first; the open one always counts.
  const ids = [v.current, ...v.threads.map((t) => t.id)].filter((id): id is string => !!id && !!v.messages[id]);
  for (const id of [...new Set(ids)].slice(0, KEEP_THREADS)) messages[id] = v.messages[id].slice(-KEEP_MESSAGES);
  return { threads: v.threads, current: v.current, messages, at: now };
}

/** A kept value that still looks like a cache (it came off the disk). */
export function validCache(c: unknown): c is DuckCache {
  const d = c as DuckCache | null;
  return !!d && Array.isArray(d.threads) && typeof d.messages === "object" && d.messages !== null;
}

/** The view before Duck's socket syncs, from what was kept. Nothing Duck has
 *  already said is overwritten: only what the view doesn't have yet is filled. */
export function seeded(v: DuckView, c: DuckCache): DuckView {
  if (v.synced) return v;
  return {
    ...v,
    threads: v.threads.length ? v.threads : c.threads,
    current: v.current ?? c.current,
    messages: { ...c.messages, ...v.messages },
  };
}

type DuckItem = Extract<OutboxItem, { kind: "duck" }>;

const same = (a: string, b: string) => a.trim() === b.trim();

/** Whether stored message `m` is outbox item `it`, handed back by Duck. */
export function isEcho(it: DuckItem, m: StoredMessage): boolean {
  if (m.role !== "user") return false;
  if (it.threadId !== null && it.threadId !== m.threadId) return false;
  const text = userText(m);
  return same(text, it.text) || text.includes(it.text.trim());
}

/** The outbox items `history` (one thread's) shows arrived. */
export function arrivedIn(items: readonly DuckItem[], threadId: string, history: readonly StoredMessage[]): DuckItem[] {
  return items.filter(
    (it) =>
      it.threadId === threadId &&
      (it.state === "sent" || it.state === "failed") &&
      history.some((m) => m.ts >= it.at - 120_000 && isEcho(it, m)),
  );
}
