// Which of Duck's threads have news this phone hasn't seen: a last-seen time per
// thread, kept on the phone alone (its own storage key, nothing on the desktop),
// and a count of what came in while the socket was open to hear it.
//
// A thread is unread when it changed after it was last seen here; the count is
// Duck's replies and notices since then, when this page heard them arrive.

/** localStorage key. */
const KEY = "wb-duck-seen";

export interface Seen {
  /** Threads changed before this (epoch ms) count as seen: no flood on first run. */
  since: number;
  /** Per thread, the newest change seen (epoch ms, the desktop's clock). */
  at: Record<string, number>;
  /** Per thread, what came in unseen: how many, and the newest counted. */
  counts: Record<string, { n: number; ts: number }>;
}

/** What `unreadOf` reads of a thread. */
export interface ThreadStamp {
  id: string;
  updated: number;
}

/** The roles that are news: Duck's replies and its notices (a task's files, a
 *  report), never your own messages. */
const NEWS = new Set(["assistant", "notice"]);

export function freshSeen(now: number): Seen {
  return { since: now, at: {}, counts: {} };
}

/** `id` seen up to `at`; `s` itself when that changes nothing. */
export function markSeen(s: Seen, id: string, at: number): Seen {
  const was = s.at[id] ?? 0;
  if (was >= at && !s.counts[id]) return s;
  const counts = { ...s.counts };
  delete counts[id];
  return { ...s, at: { ...s.at, [id]: Math.max(was, at) }, counts };
}

/** A message arrived in a thread not being looked at. */
export function noteMessage(s: Seen, m: { threadId: string; role: string; ts: number }): Seen {
  if (!NEWS.has(m.role)) return s;
  const id = m.threadId;
  const c = s.counts[id];
  // Once only, however often it is sent again (a resync).
  if (m.ts <= Math.max(s.at[id] ?? s.since, c?.ts ?? 0)) return s;
  return { ...s, counts: { ...s.counts, [id]: { n: (c?.n ?? 0) + 1, ts: m.ts } } };
}

/** Whether `t` has news, and how many messages if this page counted them. */
export function unreadOf(s: Seen, t: ThreadStamp): { unread: boolean; n: number } {
  const n = s.counts[t.id]?.n ?? 0;
  return { unread: n > 0 || t.updated > (s.at[t.id] ?? s.since), n };
}

/** Any of `threads`, but `except`, with news. */
export function anyUnread(s: Seen, threads: readonly ThreadStamp[], except: string | null = null): boolean {
  return threads.some((t) => t.id !== except && unreadOf(s, t).unread);
}

/** Forget threads that are gone; `s` itself when none are. */
export function prune(s: Seen, ids: readonly string[]): Seen {
  const keep = new Set(ids);
  const gone = [...Object.keys(s.at), ...Object.keys(s.counts)].filter((id) => !keep.has(id));
  if (!gone.length) return s;
  const at = { ...s.at };
  const counts = { ...s.counts };
  for (const id of gone) {
    delete at[id];
    delete counts[id];
  }
  return { ...s, at, counts };
}

export function loadSeen(now = Date.now()): Seen {
  try {
    const raw = localStorage.getItem(KEY);
    const s = raw ? (JSON.parse(raw) as Partial<Seen>) : null;
    if (s && typeof s.since === "number") return { since: s.since, at: s.at ?? {}, counts: s.counts ?? {} };
  } catch {
    // no storage, or garbled: start over
  }
  const s = freshSeen(now);
  saveSeen(s);
  return s;
}

export function saveSeen(s: Seen): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    // no storage: unread lasts this page only
  }
}
