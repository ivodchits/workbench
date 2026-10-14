import { describe, expect, it } from "vitest";

import type { TranscriptPage } from "../ipc/transcript";
import { fixtures, sessionLines } from "./fixtures.test-util";
import {
  createFeed,
  lastAssistantText,
  readLastResponse,
  readPlans,
  type FeedChange,
  type TranscriptSource,
} from "./feed";
import { createTranscript } from "./model";

/** A transcript "file" held in memory, with the T1 contract: offsets are byte
 *  offsets on line boundaries (here: the sum of line lengths + 1). */
function fakeFile(sessionId: string, lines: string[], pageBytes: number) {
  const starts: number[] = [];
  let end = 0;
  for (const l of lines) {
    starts.push(end);
    end += l.length + 1;
  }
  let reads = 0;
  return {
    sessionId,
    get end() {
      return end;
    },
    get reads() {
      return reads;
    },
    offsetOf: (index: number) => (index >= lines.length ? end : starts[index]),
    readBack(before = end): TranscriptPage {
      reads++;
      let last = starts.findIndex((s) => s >= before);
      if (last < 0) last = lines.length;
      let first = last;
      while (first > 0 && (first === last || before - starts[first - 1] <= pageBytes)) first--;
      return {
        sessionId,
        lines: lines.slice(first, last),
        offset: first < lines.length ? starts[first] : end,
        nextOffset: before,
        end,
      };
    },
  };
}

function fakeSource(file: ReturnType<typeof fakeFile>, liveFrom: number) {
  let appended: Parameters<TranscriptSource["onAppended"]>[0] = () => {};
  let rotated: Parameters<TranscriptSource["onRotated"]>[0] = () => {};
  let current = file;
  const calls = { unfollow: 0, unlisten: 0 };
  const source: TranscriptSource = {
    follow: async () => ({ sessionId: current.sessionId, offset: liveFrom }),
    unfollow: () => void calls.unfollow++,
    readBack: async (before) => current.readBack(before),
    onAppended: async (cb) => {
      appended = cb;
      return () => void calls.unlisten++;
    },
    onRotated: async (cb) => {
      rotated = cb;
      return () => void calls.unlisten++;
    },
  };
  return {
    source,
    calls,
    append: (lines: string[], sessionId = current.sessionId) => appended({ sessionId, lines }),
    rotate(next: ReturnType<typeof fakeFile> | null, offset: number) {
      if (next) current = next;
      rotated({ sessionId: next ? next.sessionId : null, offset });
    },
  };
}

/** Let the feed's pending reads settle. */
const settle = () => new Promise((r) => setTimeout(r, 0));

function wholeSession() {
  const t = createTranscript();
  t.append(sessionLines);
  return [...t.items];
}

describe("feed", () => {
  it("joins history to the live stream", async () => {
    const cut = sessionLines.length - 40;
    const file = fakeFile("s1", sessionLines.slice(0, cut), 64 * 1024);
    const fake = fakeSource(file, file.end);
    const changes: FeedChange[] = [];
    const feed = createFeed(fake.source, (why) => changes.push(why));
    expect(changes).toEqual([]); // never called before createFeed returns
    await settle();
    expect(feed.ready).toBe(true);
    expect(feed.items.length).toBeGreaterThan(0);

    fake.append(sessionLines.slice(cut));
    expect(changes[changes.length - 1]).toBe("append");

    while (feed.hasEarlier) await feed.loadEarlier();
    expect(feed.items).toEqual(wholeSession());
    feed.stop();
  });

  it("loads only the end of a long session until asked for more", async () => {
    const file = fakeFile("s1", sessionLines, 16 * 1024);
    const feed = createFeed(fakeSource(file, file.end).source, () => {});
    await settle();
    const all = wholeSession();
    expect(feed.hasEarlier).toBe(true);
    expect(feed.items.length).toBeLessThan(all.length);
    // What is loaded is the end of the conversation.
    expect(feed.items[feed.items.length - 1]).toEqual(all[all.length - 1]);

    const before = feed.items.length;
    await feed.loadEarlier();
    expect(feed.items.length).toBeGreaterThan(before);
    feed.stop();
  });

  it("a session followed from its top has no history to load", async () => {
    const file = fakeFile("s1", [], 1024);
    const fake = fakeSource(file, 0);
    const feed = createFeed(fake.source, () => {});
    await settle();
    expect(feed.hasEarlier).toBe(false);
    expect(file.reads).toBe(0);
    fake.append(fixtures["01-text-turn"]);
    expect(feed.items.map((i) => i.kind)).toEqual(["user", "assistant", "turn-end"]);
    feed.stop();
  });

  it("starts over on a rotation, and ignores lines of the transcript it left", async () => {
    const file = fakeFile("s1", fixtures["02-read"], 1 << 20);
    const fake = fakeSource(file, file.end);
    const changes: FeedChange[] = [];
    const feed = createFeed(fake.source, (why) => changes.push(why));
    await settle();
    expect(feed.items.length).toBeGreaterThan(0);

    // `/clear`: nothing to show until the new session writes.
    fake.rotate(null, 0);
    expect(changes[changes.length - 1]).toBe("reset");
    expect(feed.items).toEqual([]);
    fake.append(fixtures["01-text-turn"], "s1");
    expect(feed.items).toEqual([]);

    const next = fakeFile("s2", [], 1024);
    fake.rotate(next, 0);
    fake.append(fixtures["16-clear-new-session"], "s2");
    expect(feed.items[0]).toMatchObject({ kind: "divider", reason: "clear" });
    feed.stop();
  });

  it("a rotation onto an existing session pages its history in", async () => {
    const fake = fakeSource(fakeFile("s1", [], 1024), 0);
    const feed = createFeed(fake.source, () => {});
    await settle();
    const resumed = fakeFile("s2", fixtures["03-bash-auto-allowed"], 1 << 20);
    fake.rotate(resumed, resumed.end);
    await settle();
    expect(feed.items.some((i) => i.kind === "tool" && i.name === "Bash")).toBe(true);
    expect(feed.hasEarlier).toBe(false);
    feed.stop();
  });

  it("drops a page that arrives after the transcript changed", async () => {
    const file = fakeFile("s1", fixtures["02-read"], 1 << 20);
    const fake = fakeSource(file, file.end);
    // The rotation lands while the first history read is in flight.
    const read = fake.source.readBack;
    let reads = 0;
    fake.source.readBack = async (before) => {
      const page = await read(before);
      if (reads++ === 0) fake.rotate(null, 0);
      return page;
    };
    const feed = createFeed(fake.source, () => {});
    await settle();
    expect(reads).toBe(1);
    expect(feed.items).toEqual([]);
    feed.stop();
  });

  it("releases its follow and listeners when stopped, even mid-start", async () => {
    const file = fakeFile("s1", sessionLines, 1 << 20);
    const early = fakeSource(file, file.end);
    createFeed(early.source, () => {}).stop();
    await settle();
    expect(early.calls.unlisten).toBe(2);

    const late = fakeSource(file, file.end);
    const feed = createFeed(late.source, () => {});
    await settle();
    feed.stop();
    expect(late.calls).toEqual({ unfollow: 1, unlisten: 2 });
    late.append(fixtures["01-text-turn"]);
  });
});

describe("last response", () => {
  it("is the last thing Claude said", () => {
    const t = createTranscript();
    t.append(fixtures["02-read"]);
    const text = lastAssistantText(t.items);
    expect(text).not.toBeNull();
    const answers = t.items.filter((i) => i.kind === "assistant");
    expect(text).toBe(answers[answers.length - 1].kind === "assistant" && answers[answers.length - 1].text);
  });

  it("is found by paging back from the end", async () => {
    // Small pages: the trailing bookkeeping lines fill the first ones.
    const file = fakeFile("s1", sessionLines, 4 * 1024);
    const text = await readLastResponse(async (before) => file.readBack(before));
    expect(text).toBe(lastAssistantText(wholeSession()));
    expect(file.reads).toBeGreaterThan(1);
  });

  it("is null for a session with no answer yet", async () => {
    const empty = fakeFile("s1", [], 1024);
    expect(await readLastResponse(async (before) => empty.readBack(before))).toBeNull();
  });
});

describe("readPlans", () => {
  it("finds the session's plan, paging back through the file", async () => {
    const file = fakeFile("s1", sessionLines, 32 * 1024);
    const plans = await readPlans(async (before) => file.readBack(before));
    expect(plans).toHaveLength(1);
    expect(plans[0].text).toContain("subtract");
    expect(plans[0].title.length).toBeGreaterThan(0);
    expect(plans[0].title.startsWith("#")).toBe(false);
    expect(file.reads).toBeGreaterThan(1);
  });

  it("is empty for a session with no plan", async () => {
    const file = fakeFile("s1", fixtures["01-text-turn"], 1024);
    expect(await readPlans(async (before) => file.readBack(before))).toEqual([]);
  });
});
