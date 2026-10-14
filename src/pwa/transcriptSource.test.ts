import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { TranscriptFrame } from "../remote/protocol";
import { createFeed } from "../transcript/feed";
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
