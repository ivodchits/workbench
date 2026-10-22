// Duck's thread store (step A2): the threads, their messages and the tool batches
// waiting on a confirmation, held in memory and persisted to duck.db through the
// `assistant_thread_*` / `assistant_message_append` / `assistant_pending_*` commands.
// An external store in the house pattern (snapshots replaced, never mutated, so a
// `useSyncExternalStore` view can sit on top).
//
// Messages are append-only, here and in the database: the engine only ever adds to
// a thread, and the backend refuses any `seq` but the next.
//
// Images (a screenshot's, step V3) stay in memory only: what's written has a line
// in their place (`withoutImages`), so nothing of the screen reaches the disk and a
// thread reopened after a restart says one was there.

import * as ipc from "../ipc/assistant";
import type { StoredMessage, StoredRole, ThreadRow } from "../ipc/assistant";

export const IMAGE_GONE = "[an image (a screenshot), not kept]";

/** `content` with every image block, at any depth, replaced by a line saying so. */
export function withoutImages<T>(content: T): T {
  if (Array.isArray(content))
    return content.map((b: unknown) =>
      b && typeof b === "object" && (b as { type?: unknown }).type === "image"
        ? { type: "text", text: IMAGE_GONE }
        : withoutImages(b),
    ) as T;
  if (content && typeof content === "object") {
    const o = content as Record<string, unknown>;
    if (!Array.isArray(o.content) && !Array.isArray(o.calls) && !(o.result && typeof o.result === "object")) return content;
    const out: Record<string, unknown> = { ...o };
    for (const k of ["content", "calls", "result"]) if (k in o) out[k] = withoutImages(o[k]);
    return out as T;
  }
  return content;
}

/** One call of a tool batch: run already, or waiting for an answer. */
export interface BatchCall {
  id: string;
  name: string;
  input: unknown;
  state: "done" | "ask" | "allowed" | "denied";
  /** The `tool_result` block, once there is one. */
  result?: unknown;
  /** What the tool's `prepare` returned, for its card and its run. */
  prepared?: unknown;
}

/** The tool calls of one assistant message, parked until every `ask` is answered. */
export interface PendingBatch {
  id: string;
  threadId: string;
  calls: BatchCall[];
  /** One call of the subscription brain's (step M3), which heard it's waiting:
   *  its answer goes back as a Workbench event, not as the turn's next request. */
  brain?: boolean;
}

/** The persistence the store needs; the IPC commands in the app, fakes in tests. */
export interface ThreadBackend {
  threadCreate(id: string, mode: string): Promise<ThreadRow>;
  threadList(): Promise<ThreadRow[]>;
  threadMessages(threadId: string): Promise<StoredMessage[]>;
  threadTitle(threadId: string, title: string): Promise<void>;
  threadDelete(threadId: string): Promise<void>;
  messageAppend(m: StoredMessage): Promise<void>;
  pendingPut(id: string, threadId: string, data: unknown): Promise<void>;
  pendingList(): Promise<{ id: string; threadId: string; data: unknown }[]>;
  pendingClear(id: string): Promise<void>;
  /** Step L4; a backend without it keeps the pin in memory only. */
  threadKeep?(threadId: string, keep: boolean): Promise<void>;
}

export const ipcBackend: ThreadBackend = ipc;

export interface ThreadStore {
  /** Load the thread list and the open confirmations. */
  load(): Promise<void>;
  threads(): readonly ThreadRow[];
  thread(id: string): ThreadRow | undefined;
  /** A thread's messages, loading them on first use. */
  messages(threadId: string): Promise<readonly StoredMessage[]>;
  /** Already-loaded messages (empty if not loaded). */
  loaded(threadId: string): readonly StoredMessage[];
  create(mode?: string): Promise<ThreadRow>;
  setTitle(threadId: string, title: string): Promise<ThreadRow | undefined>;
  /** Keep a thread from housekeeping's clean-up of idle threads (step L4). */
  setKeep(threadId: string, keep: boolean): Promise<ThreadRow | undefined>;
  append(
    threadId: string,
    role: StoredRole,
    content: unknown,
    source: string,
  ): Promise<StoredMessage>;
  /** Delete a thread with its messages and parked batches (after any append in
   *  flight lands). */
  remove(threadId: string): Promise<void>;
  pending(): readonly PendingBatch[];
  putPending(b: PendingBatch): Promise<void>;
  clearPending(id: string): Promise<void>;
  subscribe(cb: () => void): () => void;
}

export function createThreadStore(
  backend: ThreadBackend,
  opts: { now?: () => number; newId?: () => string } = {},
): ThreadStore {
  const now = opts.now ?? Date.now;
  const newId = opts.newId ?? (() => crypto.randomUUID());
  let threads: ThreadRow[] = [];
  const messages = new Map<string, StoredMessage[]>();
  const loading = new Map<string, Promise<StoredMessage[]>>();
  let pending: PendingBatch[] = [];
  // Appends to one thread run one after another, so each gets the right `seq`.
  const tails = new Map<string, Promise<unknown>>();
  const listeners = new Set<() => void>();

  const emit = () => {
    for (const l of listeners) l();
  };
  const sortThreads = () => {
    threads = [...threads].sort(
      (a, b) => b.updated - a.updated || b.created - a.created,
    );
  };
  const patchThread = (id: string, patch: Partial<ThreadRow>) => {
    threads = threads.map((t) => (t.id === id ? { ...t, ...patch } : t));
  };

  async function ensure(threadId: string): Promise<StoredMessage[]> {
    const have = messages.get(threadId);
    if (have) return have;
    let p = loading.get(threadId);
    if (!p) {
      p = backend.threadMessages(threadId).then((ms) => {
        messages.set(threadId, ms);
        loading.delete(threadId);
        return ms;
      });
      loading.set(threadId, p);
    }
    return p;
  }

  return {
    async load() {
      const [ts, ps] = await Promise.all([
        backend.threadList(),
        backend.pendingList(),
      ]);
      threads = ts;
      sortThreads();
      pending = ps.map((p) => ({
        ...(p.data as PendingBatch),
        id: p.id,
        threadId: p.threadId,
      }));
      emit();
    },
    threads: () => threads,
    thread: (id) => threads.find((t) => t.id === id),
    messages: ensure,
    loaded: (id) => messages.get(id) ?? [],
    async create(mode = "assistant") {
      const t = await backend.threadCreate(newId(), mode);
      threads = [t, ...threads];
      messages.set(t.id, []);
      emit();
      return t;
    },
    async setTitle(threadId, title) {
      await backend.threadTitle(threadId, title);
      patchThread(threadId, { title: title.trim() });
      emit();
      return threads.find((t) => t.id === threadId);
    },
    async setKeep(threadId, keep) {
      await backend.threadKeep?.(threadId, keep);
      patchThread(threadId, { keep });
      emit();
      return threads.find((t) => t.id === threadId);
    },
    append(threadId, role, content, source) {
      const prev = tails.get(threadId) ?? Promise.resolve();
      const next = prev
        .catch(() => {})
        .then(async () => {
          const have = await ensure(threadId);
          const m: StoredMessage = {
            threadId,
            seq: have.length,
            ts: now(),
            role,
            content,
            source,
          };
          await backend.messageAppend({ ...m, content: withoutImages(m.content) });
          messages.set(threadId, [...have, m]);
          patchThread(threadId, {
            updated: Math.max(
              m.ts,
              threads.find((t) => t.id === threadId)?.updated ?? 0,
            ),
          });
          sortThreads();
          emit();
          return m;
        });
      tails.set(threadId, next);
      return next;
    },
    async remove(threadId) {
      await tails.get(threadId)?.catch(() => {});
      await backend.threadDelete(threadId);
      threads = threads.filter((t) => t.id !== threadId);
      pending = pending.filter((p) => p.threadId !== threadId);
      messages.delete(threadId);
      loading.delete(threadId);
      tails.delete(threadId);
      emit();
    },
    pending: () => pending,
    async putPending(b) {
      await backend.pendingPut(b.id, b.threadId, { calls: withoutImages(b.calls) });
      pending = [...pending.filter((p) => p.id !== b.id), b];
      emit();
    },
    async clearPending(id) {
      await backend.pendingClear(id);
      pending = pending.filter((p) => p.id !== id);
      emit();
    },
    subscribe(cb) {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
  };
}
