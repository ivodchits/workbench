import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { TranscriptFrame } from "../remote/protocol";
import { createFeed } from "../transcript/feed";
import { fresh, type TranscriptCache } from "./transcriptCache";
import { transcriptSource, type SocketLike } from "./transcriptSource";

class FakeSocket implements SocketLike {
  readyState = 0;
  onopen: ((ev: Event) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onclose: ((ev: CloseEvent) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  sent: unknown[] = [];
  constructor(readonly params: Record<string, string>) {}
  open(): void {
    this.readyState = 1;
    this.onopen?.(new Event("open"));
  }
  frame(f: TranscriptFrame): void {
    this.onmessage?.({ data: JSON.stringify(f) } as MessageEvent);
  }
  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }
  close(): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.onclose?.({} as CloseEvent);
  }
}

const user = (uuid: string, text: string) =>
  JSON.stringify({ type: "user", uuid, message: { role: "user", content: text } });

/** Let pending promise callbacks run (timers are faked). */
const tick = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

describe("phone transcript source", () => {
  let sockets: FakeSocket[];
  const source = () =>
    transcriptSource("i1", {
      open: (params) => {
        const s = new FakeSocket(params);
        sockets.push(s);
        return s;
      },
      retryMs: 10,
    });

  beforeEach(() => {
    sockets = [];
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  });
  afterEach(() => vi.useRealTimers());

  it("feeds history, live lines, and resumes after a drop without reloading", async () => {
    const changes: string[] = [];
    const feed = createFeed(source(), (why) => changes.push(why));
    await tick();
    const first = sockets[0];
    expect(first.params).toEqual({ instance: "i1" });
    first.open();
    first.frame({ type: "start", sessionId: "s1", offset: 100 });
    await tick();
    // The feed pages history back from the start offset.
    expect(first.sent).toEqual([{ type: "back", id: 1, before: 100 }]);
    first.frame({
      type: "page", id: 1, sessionId: "s1", lines: [user("a", "earlier")], offset: 0, nextOffset: 100, end: 100,
    });
    await tick();
    expect(feed.items.map((i) => i.kind)).toEqual(["user"]);
    expect(feed.hasEarlier).toBe(false);

    first.frame({ type: "lines", sessionId: "s1", lines: [user("b", "live")], offset: 100, nextOffset: 180 });
    first.frame({ type: "lines", sessionId: "s1", lines: [], offset: 180, nextOffset: 400 });
    expect(feed.items).toHaveLength(2);

    // Dropped: the next connection names where we were…
    first.close();
    vi.advanceTimersByTime(10);
    const second = sockets[1];
    expect(second.params).toEqual({ instance: "i1", session: "s1", offset: "400" });
    second.open();
    // …and the server carries on from there: nothing is re-read.
    second.frame({ type: "resume", sessionId: "s1", offset: 400 });
    second.frame({ type: "lines", sessionId: "s1", lines: [user("c", "after")], offset: 400, nextOffset: 450 });
    expect(feed.items).toHaveLength(3);
    expect(second.sent).toEqual([]);
    expect(changes).not.toContain("reset");
    feed.stop();
    expect(second.readyState).toBe(3);
    vi.advanceTimersByTime(50);
    expect(sockets).toHaveLength(2);
  });

  it("starts over when a reconnect can't resume, and on a rotation", async () => {
    const changes: string[] = [];
    const feed = createFeed(source(), (why) => changes.push(why));
    await tick();
    sockets[0].open();
    sockets[0].frame({ type: "start", sessionId: "s1", offset: 0 });
    sockets[0].frame({ type: "lines", sessionId: "s1", lines: [user("a", "one")], offset: 0, nextOffset: 50 });
    await tick();
    expect(feed.items).toHaveLength(1);

    sockets[0].close();
    vi.advanceTimersByTime(10);
    sockets[1].open();
    // The session moved on while we were away (a /clear).
    sockets[1].frame({ type: "start", sessionId: "s2", offset: 0 });
    await tick();
    expect(changes).toContain("reset");
    expect(feed.items).toHaveLength(0);
    sockets[1].frame({ type: "lines", sessionId: "s2", lines: [user("b", "two")], offset: 0, nextOffset: 60 });
    expect(feed.items).toHaveLength(1);

    sockets[1].frame({ type: "rotated", sessionId: null, offset: 0, reason: "clear" });
    await tick();
    expect(feed.items).toHaveLength(0);
    // Nothing to resume while the new session hasn't reported in.
    sockets[1].close();
    vi.advanceTimersByTime(10);
    expect(sockets[2].params).toEqual({ instance: "i1" });
    feed.stop();
  });

  it("fails a history read that the connection drops, keeping what is loaded", async () => {
    const feed = createFeed(source(), () => {});
    await tick();
    sockets[0].open();
    sockets[0].frame({ type: "start", sessionId: "s1", offset: 500 });
    await tick();
    expect(sockets[0].sent).toHaveLength(1);
    sockets[0].close();
    await tick();
    expect(feed.loading).toBe(false);
    expect(feed.hasEarlier).toBe(true);
    feed.stop();
  });
});

describe("phone transcript source with a kept tail", () => {
  let sockets: FakeSocket[];
  let saved: TranscriptCache[];
  const source = (initial: TranscriptCache | null) =>
    transcriptSource("i1", {
      open: (params) => {
        const s = new FakeSocket(params);
        sockets.push(s);
        return s;
      },
      retryMs: 10,
      waitMs: 100,
      cache: { initial, save: (c) => saved.push(c) },
    });

  beforeEach(() => {
    sockets = [];
    saved = [];
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  });
  afterEach(() => vi.useRealTimers());

  it("keeps what it sees: history pages and live lines", async () => {
    const feed = createFeed(source(null), () => {});
    await tick();
    sockets[0].open();
    sockets[0].frame({ type: "start", sessionId: "s1", offset: 100 });
    await tick();
    sockets[0].frame({ type: "page", id: 1, sessionId: "s1", lines: [user("a", "earlier")], offset: 0, nextOffset: 100, end: 100 });
    await tick();
    sockets[0].frame({ type: "lines", sessionId: "s1", lines: [user("b", "live")], offset: 100, nextOffset: 180 });
    const last = saved[saved.length - 1];
    expect(last).toMatchObject({ sessionId: "s1", start: 0, end: 180 });
    expect(last.chunks.flatMap((c) => c.lines)).toHaveLength(2);
    feed.stop();
  });

  it("opens on the kept tail at once, offline, and resumes after it", async () => {
    let kept = fresh("s1", 40);
    kept = { ...kept, end: 120, chunks: [{ offset: 40, nextOffset: 120, lines: [user("a", "kept one"), user("b", "kept two")] }] };
    const feed = createFeed(source(kept), () => {});
    await tick();
    // Shown before any socket opened.
    expect(feed.items).toHaveLength(2);
    expect(feed.ready).toBe(true);
    expect(sockets[0].params).toEqual({ instance: "i1", session: "s1", offset: "120" });
    // The earlier history waits for the socket…
    expect(feed.hasEarlier).toBe(true);
    const more = feed.loadEarlier();
    sockets[0].open();
    sockets[0].frame({ type: "resume", sessionId: "s1", offset: 120 });
    await tick();
    expect(sockets[0].sent).toEqual([{ type: "back", id: 1, before: 40 }]);
    sockets[0].frame({ type: "page", id: 1, sessionId: "s1", lines: [user("z", "older")], offset: 0, nextOffset: 40, end: 120 });
    await more;
    expect(feed.items).toHaveLength(3);
    // …and the live stream goes on from the cache's end.
    sockets[0].frame({ type: "lines", sessionId: "s1", lines: [user("c", "new")], offset: 120, nextOffset: 150 });
    expect(feed.items).toHaveLength(4);
    expect(saved[saved.length - 1]).toMatchObject({ start: 0, end: 150 });
    feed.stop();
  });

  it("starts over from the desktop's copy when the kept tail can't be resumed", async () => {
    const kept = { ...fresh("s1", 0), end: 50, chunks: [{ offset: 0, nextOffset: 50, lines: [user("a", "stale")] }] };
    const changes: string[] = [];
    const feed = createFeed(source(kept), (why) => changes.push(why));
    await tick();
    expect(feed.items).toHaveLength(1);
    sockets[0].open();
    sockets[0].frame({ type: "start", sessionId: "s2", offset: 0 });
    await tick();
    expect(changes).toContain("reset");
    expect(feed.items).toHaveLength(0);
    expect(saved[saved.length - 1]).toMatchObject({ sessionId: "s2", start: 0, end: 0 });
    feed.stop();
  });

  it("gives up on a history read when the socket doesn't come up", async () => {
    const kept = { ...fresh("s1", 40), end: 80, chunks: [{ offset: 40, nextOffset: 80, lines: [user("a", "kept")] }] };
    const feed = createFeed(source(kept), () => {});
    await tick();
    const more = feed.loadEarlier();
    vi.advanceTimersByTime(150);
    await more;
    expect(feed.loading).toBe(false);
    expect(feed.hasEarlier).toBe(true);
    feed.stop();
  });
});
