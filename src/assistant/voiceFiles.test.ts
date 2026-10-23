// Talking about what you drop (G2): which turn a file goes with, the counting
// wait, and late drops.

import { describe, expect, it } from "vitest";

import type { AttachmentRef } from "./attachments";
import { AFTER_MS, COUNT_WAIT_MS, createVoiceFiles, manifestLine, pillText, spokenCount, type Sent } from "./voiceFiles";

const file = (name: string): AttachmentRef => ({ id: name.padEnd(32, "0").slice(0, 32), name, mime: "text/plain", size: 10 });
const plan = file("plan.md");
const shot = file("error.png");

function harness() {
  let now = 0;
  const timers: { at: number; fn: () => void; on: boolean }[] = [];
  const sends: { files: string[] }[] = [];
  const late: string[][] = [];
  const back: string[][] = [];
  const v = createVoiceFiles({
    now: () => now,
    later(ms, fn) {
      const t = { at: now + ms, fn, on: true };
      timers.push(t);
      return () => (t.on = false);
    },
    changed() {},
    back: (f) => back.push(f.map((x) => x.name)),
  });
  const go = (files: AttachmentRef[]): Sent => {
    sends.push({ files: files.map((f) => f.name) });
    return { late: (f) => late.push(f.map((x) => x.name)) };
  };
  const tick = (ms: number) => {
    now += ms;
    for (const t of timers.filter((t) => t.on && t.at <= now)) {
      t.on = false;
      t.fn();
    }
  };
  const drop = (...fs: AttachmentRef[]) => {
    if (!v.claims()) return false;
    v.expect(fs.length);
    v.arrive(fs);
    return true;
  };
  return { v, go, sends, late, back, tick, drop };
}

describe("spokenCount", () => {
  it.each([
    ["have a look at these two files and do a couple of things with them", 2, true],
    ["compare these two", 2, false],
    ["look at both", 2, false],
    ["merge both pictures", 2, true],
    ["посмотри эти три файла", 3, true],
    ["сравни эти два", 2, false],
    ["mira estos dos archivos", 2, true],
    ["check the 3 screenshots", 3, true],
    ["vergleiche diese zwei Dateien", 2, true],
    ["regarde les deux", 2, false],
  ])("%s → %d", (text, count, explicit) => {
    expect(spokenCount(text)).toEqual({ count, explicit });
  });

  it.each(["look at these files", "do a couple of things", "I have two questions", "one file please", "it's 2 o'clock"])(
    "%s → no count",
    (text) => {
      expect(spokenCount(text)).toBeNull();
    },
  );
});

describe("manifest and pill", () => {
  it("names the files", () => {
    expect(manifestLine([plan, shot])).toBe("2 files: plan.md, error.png");
    expect(manifestLine([plan])).toBe("1 file: plan.md");
  });
  it("shows the files, then the wait", () => {
    expect(pillText(2, 0)).toBe("🎤 + 2 files");
    expect(pillText(1, 0, 1)).toBe("🎤 + 2 files (adding…)");
    expect(pillText(1, 1)).toBe("waiting for 1 more file…");
  });
});

describe("a voice turn's files", () => {
  it("drops while you talk go with the words", () => {
    const h = harness();
    expect(h.v.claims()).toBe(false);
    h.v.opened();
    expect(h.drop(plan)).toBe(true);
    expect(h.drop(shot)).toBe(true);
    h.v.closed();
    h.v.turn("have a look at these two files", h.go);
    expect(h.sends).toEqual([{ files: ["plan.md", "error.png"] }]);
    expect(h.v.files()).toEqual([]);
  });

  it("files staged just before take part, and words without files go alone", () => {
    const h = harness();
    h.v.opened([plan, shot]);
    h.v.closed();
    h.v.turn("these two", h.go);
    expect(h.sends[0].files).toEqual(["plan.md", "error.png"]);
    h.v.opened();
    h.v.closed();
    h.v.turn("compare these two", h.go);
    expect(h.sends[1].files).toEqual([]);
  });

  it("words that count wait for the rest, and take it when it lands", () => {
    const h = harness();
    h.v.opened();
    h.drop(plan);
    h.v.closed();
    h.v.turn("have a look at these two", h.go);
    expect(h.sends).toEqual([]);
    expect(h.v.missing()).toBe(1);
    h.tick(2000);
    h.drop(shot);
    expect(h.sends).toEqual([{ files: ["plan.md", "error.png"] }]);
    expect(h.v.missing()).toBe(0);
  });

  it("the wait gives up after its time", () => {
    const h = harness();
    h.v.opened();
    h.drop(plan);
    h.v.closed();
    h.v.turn("these two files", h.go);
    h.tick(COUNT_WAIT_MS);
    expect(h.sends).toEqual([{ files: ["plan.md"] }]);
  });

  it("a file still being stored holds the words until it's there", () => {
    const h = harness();
    h.v.opened();
    h.v.expect(1);
    h.v.closed();
    h.v.turn("look at this", h.go);
    expect(h.sends).toEqual([]);
    h.v.arrive([plan]);
    expect(h.sends).toEqual([{ files: ["plan.md"] }]);
  });

  it("a drop after the words went is late, within the window", () => {
    const h = harness();
    h.v.opened();
    h.drop(plan);
    h.v.closed();
    h.v.turn("look at this", h.go);
    h.tick(2000);
    expect(h.drop(shot)).toBe(true);
    expect(h.late).toEqual([["error.png"]]);
    h.tick(AFTER_MS);
    expect(h.drop(file("x.txt"))).toBe(false);
  });

  it("a drop after the turn ended but before its words is the turn's", () => {
    const h = harness();
    h.v.opened();
    h.v.closed();
    h.tick(1500);
    expect(h.drop(plan)).toBe(true);
    h.v.turn("what's this", h.go);
    expect(h.sends).toEqual([{ files: ["plan.md"] }]);
  });

  it("withdrawn words keep their files for the next words", () => {
    const h = harness();
    h.v.opened();
    h.drop(plan);
    h.v.closed();
    h.v.turn("look at", h.go);
    h.v.unsend();
    h.v.opened();
    h.v.closed();
    h.v.turn("look at this and fix it", h.go);
    expect(h.sends.map((s) => s.files)).toEqual([["plan.md"], ["plan.md"]]);
  });

  it("files nothing took go back to the composer", () => {
    const h = harness();
    h.v.opened();
    h.drop(plan);
    h.v.closed();
    h.tick(AFTER_MS);
    expect(h.back).toEqual([["plan.md"]]);
    expect(h.v.files()).toEqual([]);
  });

  it("a turn from before a reload takes a share within the window", () => {
    const h = harness();
    h.tick(20_000);
    const late: string[] = [];
    h.v.resume(20_000 - 6000, { late: (f) => late.push(...f.map((x) => x.name)) });
    expect(h.drop(shot)).toBe(true);
    expect(late).toEqual(["error.png"]);
    h.tick(5000);
    expect(h.v.claims()).toBe(false);
  });

  it("a new turn starts its own files: the last one's late window closes", () => {
    const h = harness();
    h.v.opened();
    h.v.closed();
    h.v.turn("hi", h.go);
    h.v.opened();
    h.drop(plan);
    expect(h.late).toEqual([]);
    expect(h.v.files().map((f) => f.name)).toEqual(["plan.md"]);
  });
});
