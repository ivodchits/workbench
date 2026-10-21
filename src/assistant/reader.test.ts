import { describe, expect, it } from "vitest";
import { hashText, Reader, sections, sentencesOf, type ReaderDeps, type ReaderView, type ReadJob, type ReadPosition, type Spoken, type Voice } from "./reader";

const tick = () => new Promise((r) => setTimeout(r, 0));

/** A voice whose sections finish when the test says so. */
function fakeVoice() {
  const heard: string[][] = [];
  let finish: ((ok: boolean) => void) | null = null;
  const v: Voice & { heard: string[][]; end(ok?: boolean): Promise<void>; cuts: number } = {
    where: "desktop",
    heard,
    cuts: 0,
    async play(sentences) {
      const said = (await Promise.all(sentences)).filter((s): s is Spoken => !!s).map((s) => s.text);
      heard.push(said);
      return new Promise<boolean>((r) => (finish = r));
    },
    cut() {
      v.cuts++;
      finish?.(false);
      finish = null;
    },
    async end(ok = true) {
      await tick();
      const f = finish;
      finish = null;
      f?.(ok);
      await tick();
      await tick();
    },
  };
  return v;
}

function setup(over: Partial<ReaderDeps> = {}) {
  const kept = new Map<string, ReadPosition>();
  const views: (ReaderView | null)[] = [];
  const ended: string[] = [];
  const narrated: string[] = [];
  const deps: ReaderDeps = {
    narrate: async (t) => {
      narrated.push(t);
      return `told: ${t}`;
    },
    prepare: async (s) => ({ text: s, lang: "en" }),
    load: (k) => kept.get(k),
    save: (k, p) => (p ? kept.set(k, p) : kept.delete(k)),
    quiet: () => Promise.resolve(),
    changed: (v) => views.push(v),
    ended: (_, why) => ended.push(why),
    ...over,
  };
  return { reader: new Reader(deps), kept, views, ended, narrated };
}

const job = (texts: string[], over: Partial<ReadJob> = {}): ReadJob => ({
  key: "note:p/a",
  title: "a",
  sections: texts,
  narrate: false,
  threadId: "t",
  maxChars: 1e9,
  source: { source: "note", project: "p", name: "a" },
  ...over,
});

describe("sections", () => {
  it("merges paragraphs up to the size and keeps a code block whole", () => {
    const text = "One. Two.\n\nThree.\n\n```ts\nconst a = 1;\n\nconst b = 2;\n```\n\nFour.";
    expect(sections(text, 20)).toEqual(["One. Two.\n\nThree.", "```ts\nconst a = 1;\n\nconst b = 2;\n```", "Four."]);
    expect(sections(text, 1000)).toHaveLength(1);
  });

  it("cuts a long paragraph at its sentences", () => {
    const long = Array.from({ length: 10 }, (_, i) => `Sentence number ${i} is here.`).join(" ");
    const out = sections(long, 100);
    expect(out.length).toBeGreaterThan(2);
    for (const s of out) expect(s.length).toBeLessThanOrEqual(100);
    expect(out.join(" ")).toBe(long);
  });

  it("reads a section's sentences as a reply would be", () => {
    expect(sentencesOf("Hello there. See `engine.ts` now.")).toHaveLength(2);
  });
});

describe("Reader", () => {
  it("reads section after section, then forgets the place", async () => {
    const t = setup();
    const v = fakeVoice();
    t.reader.start(job(["First.", "Second."]), v, 0);
    await v.end();
    expect(t.reader.view()?.section).toBe(1);
    expect(t.kept.get("note:p/a")?.section).toBe(1);
    await v.end();
    expect(v.heard).toEqual([["First."], ["Second."]]);
    expect(t.reader.view()).toBeNull();
    expect(t.kept.has("note:p/a")).toBe(false);
    expect(t.ended).toEqual(["the end"]);
  });

  it("waits for the reply to be over before it starts", async () => {
    let quiet!: () => void;
    const t = setup({ quiet: () => new Promise<void>((r) => (quiet = r)) });
    const v = fakeVoice();
    t.reader.start(job(["First."]), v, 0);
    await tick();
    expect(v.heard).toEqual([]);
    quiet();
    await tick();
    await tick();
    expect(v.heard).toEqual([["First."]]);
  });

  it("pauses on a cut from outside and resumes the same section", async () => {
    const t = setup();
    const v = fakeVoice();
    t.reader.start(job(["First.", "Second."]), v, 0);
    await v.end(false);
    expect(t.reader.view()?.state).toBe("paused");
    expect(t.reader.view()?.section).toBe(0);
    t.reader.resume();
    await v.end();
    await v.end();
    expect(v.heard).toEqual([["First."], ["First."], ["Second."]]);
  });

  it("pause cuts the voice; skip moves and reads from there", async () => {
    const t = setup();
    const v = fakeVoice();
    t.reader.start(job(["A.", "B.", "C."]), v, 0);
    await tick();
    t.reader.pause();
    expect(v.cuts).toBe(1);
    t.reader.skip(2);
    await tick();
    await tick();
    expect(v.heard[v.heard.length - 1]).toEqual(["C."]);
    t.reader.skip(-1);
    await tick();
    await tick();
    expect(v.heard[v.heard.length - 1]).toEqual(["B."]);
    expect(t.reader.view()?.section).toBe(1);
  });

  it("picks up where it stopped unless the source changed", async () => {
    const t = setup();
    const v = fakeVoice();
    const j = job(["A.", "B.", "C."]);
    t.reader.start(j, v, 0);
    await v.end();
    t.reader.stop();
    expect(t.reader.resumable(j)).toBe(1);
    expect(t.reader.resumable(job(["A.", "B!", "C."]))).toBe(0);
    expect(t.kept.get(j.key)?.hash).toBe(hashText("A.\n\nB.\n\nC."));
  });

  it("narrates each section when its turn comes, the next one ahead", async () => {
    const t = setup();
    const v = fakeVoice();
    t.reader.start(job(["A.", "B.", "C."], { narrate: true }), v, 0);
    await tick();
    await tick();
    expect(t.narrated).toEqual(["A.", "B."]);
    t.reader.stop();
    expect(v.heard).toEqual([["told: A."]]);
  });

  it("stops at the length asked for, keeping the place", async () => {
    const t = setup();
    const v = fakeVoice();
    t.reader.start(job(["First.", "Second.", "Third."], { maxChars: 5 }), v, 0);
    await v.end();
    expect(t.reader.view()).toBeNull();
    expect(t.ended).toEqual(["the length you asked for"]);
    expect(t.kept.get("note:p/a")?.section).toBe(1);
  });

  it("ends with the reason when the voice fails", async () => {
    const t = setup();
    const v: Voice = { where: "phone", play: () => Promise.reject(new Error("no voice")), cut() {} };
    t.reader.start(job(["A."]), v, 0);
    await tick();
    await tick();
    expect(t.ended).toEqual(["the voice failed: no voice"]);
  });
});
