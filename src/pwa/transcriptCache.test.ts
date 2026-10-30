import { describe, expect, it } from "vitest";
import { appended, fresh, pageEnding, prepended, trim, valid } from "./transcriptCache";

const page = (lines: string[], offset: number, nextOffset: number, sessionId: string | null = "s1") => ({
  sessionId,
  lines,
  offset,
  nextOffset,
  end: nextOffset,
});

describe("the kept transcript tail", () => {
  it("grows at both ends while frames continue it, and ignores what doesn't", () => {
    let c = fresh("s1", 100, 1);
    c = prepended(c, page(["a", "b"], 40, 100))!;
    c = appended(c, "s1", 100, 160, ["c"])!;
    c = appended(c, "s1", 160, 200, [])!;
    expect(c).toMatchObject({ start: 40, end: 200 });
    expect(pageEnding(c, 200)?.lines).toEqual(["a", "b", "c"]);
    // A gap, another session, or history that doesn't end at the start: refused.
    expect(appended(c, "s1", 250, 300, ["x"])).toBeNull();
    expect(appended(c, "s2", 200, 300, ["x"])).toBeNull();
    expect(prepended(c, page(["x"], 0, 30))).toBeNull();
  });

  it("serves a page ending at a chunk boundary, all of the cache up to it", () => {
    let c = fresh("s1", 0);
    c = appended(c, "s1", 0, 10, ["a"])!;
    c = appended(c, "s1", 10, 20, ["b"])!;
    c = appended(c, "s1", 20, 30, ["c"])!;
    expect(pageEnding(c, 20)).toEqual({ sessionId: "s1", lines: ["a", "b"], offset: 0, nextOffset: 20, end: 30 });
    expect(pageEnding(c, 15)).toBeNull();
    expect(pageEnding(c, 0)).toBeNull();
    expect(pageEnding(fresh("s1", 50), 50)).toBeNull();
  });

  it("drops the oldest chunks past the bounds, keeping the newest", () => {
    let c = fresh("s1", 0);
    for (let i = 0; i < 5; i++) c = appended(c, "s1", i * 10, i * 10 + 10, [`l${i}`, `m${i}`])!;
    const cut = trim(c, 5, 1e9);
    expect(cut.chunks.map((ch) => ch.lines[0])).toEqual(["l3", "l4"]);
    expect(cut.start).toBe(30);
    expect(pageEnding(cut, 50)?.offset).toBe(30);
    // One huge chunk still stays: it is the newest.
    expect(trim(c, 0, 0).chunks).toHaveLength(1);
  });

  it("checks what comes off the disk", () => {
    expect(valid(fresh("s1", 0))).toBe(true);
    expect(valid({ sessionId: "s1" })).toBe(false);
    expect(valid(null)).toBe(false);
  });
});
