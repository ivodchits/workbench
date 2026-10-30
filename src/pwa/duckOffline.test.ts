import { describe, expect, it } from "vitest";
import type { StoredMessage, ThreadRow } from "../ipc/assistant";
import { emptyView } from "./duckStore";
import { arrivedIn, cacheOf, isEcho, KEEP_MESSAGES, KEEP_THREADS, seeded, validCache } from "./duckOffline";
import type { OutboxItem } from "./outbox";

const thread = (id: string, updated = 1): ThreadRow => ({ id, title: id, mode: "chat", created: 1, updated });
const msg = (threadId: string, seq: number, role: StoredMessage["role"], text: string, ts = 10 + seq): StoredMessage => ({
  threadId,
  seq,
  ts,
  role,
  content: [{ type: "text", text }],
  source: "phone",
}) as StoredMessage;
const item = (text: string, threadId: string | null, state: OutboxItem["state"] = "sent", at = 0) =>
  ({ id: text, kind: "duck", threadId, text, at, state }) as Extract<OutboxItem, { kind: "duck" }>;

describe("Duck offline", () => {
  it("keeps the newest messages of the recent threads, the open one always", () => {
    const threads = Array.from({ length: KEEP_THREADS + 5 }, (_, i) => thread(`t${i}`));
    const messages: Record<string, StoredMessage[]> = {};
    for (const t of threads) messages[t.id] = Array.from({ length: KEEP_MESSAGES + 10 }, (_, i) => msg(t.id, i, "user", `m${i}`));
    const last = threads[threads.length - 1].id;
    const c = cacheOf({ ...emptyView(), threads, messages, current: last }, 5);
    expect(Object.keys(c.messages)).toHaveLength(KEEP_THREADS);
    expect(c.messages[last]).toBeDefined();
    expect(c.messages.t0).toHaveLength(KEEP_MESSAGES);
    expect(c.messages.t0[0].seq).toBe(10);
    expect(c).toMatchObject({ current: last, at: 5 });
  });

  it("seeds the view until Duck syncs, never over what Duck said", () => {
    const kept = { threads: [thread("a")], current: "a", messages: { a: [msg("a", 1, "user", "old")] }, at: 1 };
    const v = seeded(emptyView(), kept);
    expect(v).toMatchObject({ synced: false, current: "a", threads: [thread("a")] });
    expect(v.messages.a).toHaveLength(1);
    const live = { ...emptyView(), synced: true, threads: [thread("b")] };
    expect(seeded(live, kept)).toBe(live);
    expect(validCache(kept)).toBe(true);
    expect(validCache({ threads: 1 })).toBe(false);
  });

  it("knows a waiting message when Duck hands it back", () => {
    expect(isEcho(item("hello", "t1"), msg("t1", 1, "user", "hello "))).toBe(true);
    expect(isEcho(item("hello", null), msg("t9", 1, "user", "hello"))).toBe(true);
    expect(isEcho(item("hello", "t1"), msg("t2", 1, "user", "hello"))).toBe(false);
    expect(isEcho(item("hello", "t1"), msg("t1", 1, "assistant", "hello"))).toBe(false);
  });

  it("finds in a thread's history the messages that did arrive, but not old lookalikes", () => {
    const history = [msg("t1", 1, "user", "yes", 1_000), msg("t1", 2, "user", "later", 500_000)];
    const items = [item("yes", "t1", "failed", 400_000), item("later", "t1", "failed", 499_000), item("later", "t1", "pending", 499_000)];
    expect(arrivedIn(items, "t1", history).map((it) => it.text)).toEqual(["later"]);
  });
});
