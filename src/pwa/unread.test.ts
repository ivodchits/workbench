import { describe, expect, it } from "vitest";

import { anyUnread, freshSeen, markSeen, noteMessage, prune, unreadOf } from "./unread";

const msg = (threadId: string, ts: number, role = "assistant") => ({ threadId, role, ts });

describe("unread threads", () => {
  it("counts nothing from before the phone first looked", () => {
    const s = freshSeen(1000);
    expect(unreadOf(s, { id: "a", updated: 900 })).toEqual({ unread: false, n: 0 });
    expect(unreadOf(s, { id: "a", updated: 1100 })).toEqual({ unread: true, n: 0 });
  });

  it("counts Duck's replies and notices once each, never your own messages", () => {
    let s = freshSeen(0);
    s = noteMessage(s, msg("a", 10));
    s = noteMessage(s, msg("a", 10)); // sent again on a resync
    s = noteMessage(s, msg("a", 20, "notice"));
    s = noteMessage(s, msg("a", 30, "user"));
    expect(unreadOf(s, { id: "a", updated: 30 })).toEqual({ unread: true, n: 2 });
  });

  it("clears a thread once seen, and keeps it clear for what came before", () => {
    let s = noteMessage(freshSeen(0), msg("a", 10));
    s = markSeen(s, "a", 10);
    expect(unreadOf(s, { id: "a", updated: 10 })).toEqual({ unread: false, n: 0 });
    expect(noteMessage(s, msg("a", 9))).toBe(s);
    expect(markSeen(s, "a", 5)).toBe(s);
    expect(unreadOf(noteMessage(s, msg("a", 11)), { id: "a", updated: 11 }).n).toBe(1);
  });

  it("says whether any other thread has news, and forgets deleted ones", () => {
    let s = noteMessage(freshSeen(0), msg("a", 10));
    const threads = [{ id: "a", updated: 10 }, { id: "b", updated: 0 }];
    expect(anyUnread(s, threads)).toBe(true);
    expect(anyUnread(s, threads, "a")).toBe(false);
    s = prune(s, ["b"]);
    expect(s.counts).toEqual({});
    expect(prune(s, ["b"])).toBe(s);
  });

  it("follows Duck's shared read marks, read on another surface or not", () => {
    let s = noteMessage(freshSeen(0), msg("a", 10));
    s = noteMessage(s, msg("a", 20));
    // Read on another machine up to 20: read here too, its count gone.
    expect(unreadOf(s, { id: "a", updated: 20, news: 20, seen: 20 })).toEqual({ unread: false, n: 0 });
    // Unread everywhere: unread here, even from before this phone first looked.
    expect(unreadOf(freshSeen(100), { id: "b", updated: 50, news: 50, seen: 0 })).toEqual({ unread: true, n: 0 });
    // Seen here but the mark not back yet: still read.
    expect(unreadOf(markSeen(s, "a", 20), { id: "a", updated: 20, news: 20, seen: 5 }).unread).toBe(false);
    // New news after the shared mark counts what came after it.
    s = noteMessage(s, msg("a", 30));
    expect(unreadOf(s, { id: "a", updated: 30, news: 30, seen: 20 })).toEqual({ unread: true, n: 3 });
    // Your own message isn't news.
    expect(unreadOf(freshSeen(0), { id: "c", updated: 40, news: 0, seen: 0 }).unread).toBe(false);
  });
});
