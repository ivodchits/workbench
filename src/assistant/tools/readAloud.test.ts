import { describe, expect, it } from "vitest";
import { fakePort, project, session, toolCtx } from "../fakePort.test-util";
import { Reader, type ReadJob, type ReadPosition, type Voice } from "../reader";
import { readAloud, type ReaderHost } from "./readAloud";
import { pickMonitor, screenshotTool } from "./screenshot";
import type { MonitorInfo } from "../../ipc/screen";

/** A reader whose voice never finishes a section, and what it was asked. */
function host(over: Partial<ReaderHost> = {}) {
  const kept = new Map<string, ReadPosition>();
  const started: { job: ReadJob; from: number }[] = [];
  const reader = new Reader({
    narrate: async (t) => t,
    prepare: async (s) => ({ text: s, lang: "en" }),
    load: (k) => kept.get(k),
    save: (k, p) => (p ? kept.set(k, p) : kept.delete(k)),
    quiet: () => new Promise(() => {}),
    changed: () => {},
  });
  const start = reader.start.bind(reader);
  reader.start = (job, voice, from) => {
    started.push({ job, from });
    start(job, voice, from);
  };
  const voice: Voice = { where: "desktop", play: () => new Promise(() => {}), cut() {} };
  const h: ReaderHost = {
    reader,
    voiceFor: () => voice,
    lastKept: () => [...kept.values()].sort((a, b) => b.at - a.at)[0] ?? null,
    summarize: async () => "In short: it works.",
    ...over,
  };
  return { h, kept, started, reader };
}

const port = () =>
  fakePort({
    projects: [project({ id: "p1", name: "Backend" })],
    sessions: [session({ id: "s1", projectId: "p1", title: "api" })],
    replies: { s1: "Fixed the login redirect.\n\n```ts\nredirect(\"/home\");\n```\n\nTests pass." },
    notes: { p1: [{ id: "todo", modified: 1, size: 20, content: "Ship it.\n\nThen rest." }] },
  });

async function run(input: Record<string, unknown>, h: ReaderHost, p = port()) {
  const ctx = { ...toolCtx(p), reader: h };
  return (await readAloud.run(readAloud.schema.parse(input), ctx)) as Record<string, unknown>;
}

describe("read_aloud", () => {
  it("reads a session's last reply, narrated, on the voice that asked", async () => {
    const t = host();
    const out = await run({ source: "session", session: "api" }, t.h);
    expect(out).toMatchObject({ reading: "api's last reply", mode: "narrate", where: "on this PC", from: "the start" });
    expect(t.started[0].job).toMatchObject({ key: "session:s1:last", narrate: true, threadId: "t" });
    expect(t.reader.view()).toMatchObject({ title: "api's last reply", state: "reading" });
  });

  it("reads a note word for word, and picks up where it stopped", async () => {
    const t = host();
    await run({ source: "note", project: "Backend", name: "todo" }, t.h);
    expect(t.started[0].job).toMatchObject({ key: "note:p1/todo", narrate: false, sections: ["Ship it.\n\nThen rest."] });
    const para = (c: string) => `${c.repeat(60)}. `.repeat(8).trim();
    const long = [para("a"), para("b"), para("c")].join("\n\n");
    const p = fakePort({
      projects: [project({ id: "p1", name: "Backend" })],
      notes: { p1: [{ id: "todo", modified: 1, size: long.length, content: long }] },
    });
    t.reader.stop();
    await run({ source: "note", project: "Backend", name: "todo" }, t.h, p);
    const job = t.started[1].job;
    expect(job.sections).toHaveLength(3);
    t.kept.set(job.key, { ...t.kept.get(job.key)!, section: 2 });
    expect(await run({ source: "note", project: "Backend", name: "todo" }, t.h, p)).toMatchObject({
      from: "section 3, where it stopped last time",
    });
    expect((await run({ source: "note", project: "Backend", name: "todo", fromStart: true }, t.h, p)).from).toBe("the start");
  });

  it("continues a paused read, or the last one kept", async () => {
    const t = host();
    await run({ source: "text", text: "One. Two.", title: "the error" }, t.h);
    t.reader.pause();
    expect(await run({ source: "continue" }, t.h)).toMatchObject({ resumed: "the error" });
    t.reader.stop();
    const again = await run({ source: "continue" }, t.h);
    expect(again).toMatchObject({ reading: "the error" });
    expect(t.started).toHaveLength(2);
    await expect(run({ source: "continue" }, host().h)).rejects.toThrow("Nothing was left half-read.");
  });

  it("reads a spoken summary instead, kept apart from the full read", async () => {
    const t = host();
    const out = await run({ source: "note", project: "Backend", name: "todo", mode: "summary" }, t.h);
    expect(out.mode).toBe("summary");
    expect(t.started[0].job).toMatchObject({ key: "note:p1/todo#summary", sections: ["In short: it works."] });
  });

  it("says what's missing", async () => {
    const t = host();
    await expect(run({ source: "note", project: "Backend" }, t.h)).rejects.toThrow("needs `project` and `name`");
    await expect(run({ source: "session", session: "nope" }, t.h)).rejects.toThrow('no session "nope"');
  });
});

describe("screenshot", () => {
  const ms: MonitorInfo[] = [
    { number: 1, name: "laptop", position: "left", main: false, width: 2880, height: 1800 },
    { number: 2, name: "ARZOPA", position: "right", main: true, width: 1920, height: 1080 },
  ];

  it("names monitors by number or by where they are", () => {
    expect(pickMonitor(ms, "2")).toBe(2);
    expect(pickMonitor(ms, "left")).toBe(1);
    expect(pickMonitor(ms, "Right")).toBe(2);
    expect(pickMonitor(ms, "main")).toBe(2);
    expect(() => pickMonitor(ms, "middle")).toThrow("the monitors are 1 (left), 2 (right, main)");
  });

  it("sends the capture as images and shows a line in the thread", async () => {
    const ctx = {
      ...toolCtx(fakePort()),
      screen: {
        monitors: async () => ms,
        save: async () => [],
        capture: async (t: unknown) => {
          expect(t).toEqual({ kind: "monitor", number: 2 });
          return {
            monitors: ms,
            shots: [{ label: "monitor 2 (right, main)", pngBase64: "AAAA", width: 1430, height: 804, sourceWidth: 1920, sourceHeight: 1080 }],
          };
        },
      },
    };
    const out = (await screenshotTool.run({ target: "monitor", monitor: "right" }, ctx)) as { type: string }[];
    expect(out.map((b) => b.type)).toEqual(["text", "image"]);
    expect(ctx.notices).toEqual([{ kind: "screen", text: "screenshot: monitor 2 (right, main)" }]);
  });
});
