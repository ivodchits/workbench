// Drawings (G3): a drawing worker per thread, versions, the render and the card,
// one fix round for a version that doesn't render, the API worker's fenced source,
// and the canvas keeping its worker warm.

import { describe, expect, it } from "vitest";

import type { TaskResultFiles } from "../ipc/assistant";
import type { AttachmentRef } from "./attachments";
import { createDrawings, type Drawing, type DrawingBackend, type DrawingSourceFile } from "./drawings";
import { fakePort, project, toolCtx } from "./fakePort.test-util";
import type { DrawingView, Notice, Surface } from "./protocol";
import { DEFAULT_SETTINGS } from "./settings";
import { createTaskManager, type Task, type TaskBackend } from "./tasks";
import { draw } from "./tools/draw";

const WS = "C:\\Users\\me\\repos\\Duck";

const settle = async () => {
  for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
};

function setup(opts: { render?: (kind: string, source: string) => Promise<string> } = {}) {
  const port = fakePort({ projects: [project({ id: "app" })] });
  const results = new Map<string, TaskResultFiles>();
  const briefs: string[] = [];
  let folders = 0;
  const taskBackend: TaskBackend = {
    prepare: () => Promise.resolve(WS),
    newFolder: (ws, date, _title, brief) => {
      briefs.push(brief);
      return Promise.resolve(`${ws}\\tasks\\${date}-d${++folders}`);
    },
    result: (_ws, folder) => Promise.resolve(results.get(folder) ?? { json: null, jsonModified: null, md: null }),
    writeResult: () => Promise.resolve(),
    put: () => Promise.resolve(),
    list: () => Promise.resolve([]),
  };
  /** Sources the workers wrote, by `folder|id|n`. */
  const sources = new Map<string, DrawingSourceFile>();
  const stored: string[] = [];
  const written: string[] = [];
  const backend: DrawingBackend = {
    put: () => Promise.resolve(),
    list: () => Promise.resolve([]),
    source: (_ws, folder, id, n) => Promise.resolve(sources.get(`${folder}|${id}|${n}`) ?? null),
    write: (_ws, folder, id, n, ext, text) => {
      const path = `${folder}\\drawings\\${id}\\v${n}.${ext}`;
      written.push(path);
      sources.set(`${folder}|${id}|${n}`, { ext: ext as DrawingSourceFile["ext"], text, path });
      return Promise.resolve(path);
    },
    resultMd: (_ws, folder) => Promise.resolve(results.get(folder)?.md ?? null),
    store: (name: string): Promise<AttachmentRef> => {
      stored.push(name);
      return Promise.resolve({ id: `f${stored.length}`, name, mime: name.endsWith(".png") ? "image/png" : "image/svg+xml", size: 10, thumb: "data:image/jpeg;base64,AA" });
    },
  };
  const told: string[] = [];
  const notices: Notice[] = [];
  const events: { d: DrawingView; open?: Surface }[] = [];
  let clock = 1_000_000;
  let ids = 0;
  // eslint-disable-next-line prefer-const
  let drawings: ReturnType<typeof createDrawings>;
  const tasks = createTaskManager({
    port,
    backend: taskBackend,
    settings: () => DEFAULT_SETTINGS,
    tell: (_threadId, text) => told.push(text),
    now: () => clock,
    newId: () => `task${++ids}xxxx`,
    today: () => "2026-10-23",
    report: (t) => drawings.report(t),
    keepWarm: (t) => drawings.keepWarm(t),
  });
  const rendered: string[] = [];
  drawings = createDrawings({
    tasks,
    backend,
    render: {
      svg: (kind, source) => {
        rendered.push(`${kind}:${source}`);
        return opts.render ? opts.render(kind, source) : Promise.resolve(`<svg viewBox="0 0 10 10"><!--${source}--></svg>`);
      },
      png: () => Promise.resolve(new Blob(["png"])),
    },
    notice: (_threadId, n) => notices.push(n),
    now: () => clock,
    newId: () => `dr${++ids}abcdefgh`,
  });
  drawings.subscribe((d, open) => events.push({ d, open }));

  /** The worker of `t` wrote version `n` of `d` (as `ext`) and its result. */
  const worker = (t: Task, d: Drawing, n: number, text: string, ext: DrawingSourceFile["ext"] = "mmd") => {
    clock += 1000;
    sources.set(`${t.folder}|${d.id}|${n}`, { ext, text, path: `${t.folder}\\drawings\\${d.id}\\v${n}.${ext}` });
    results.set(t.folder, { json: JSON.stringify({ status: "done", headline: `Version ${n}.`, question: null }), jsonModified: clock, md: null });
  };
  /** Its turn ended. */
  const turnEnds = async (t: Task) => {
    const s = port.listSessions().find((x) => x.id === t.instanceId)!;
    s.phase = "done";
    port.phase(s.id, "done", "working");
    await settle();
  };
  return { port, tasks, drawings, told, notices, events, briefs, stored, written, rendered, results, worker, turnEnds, advance: (ms: number) => (clock += ms), now: () => clock };
}

const last = <T,>(xs: T[]) => xs[xs.length - 1];

const ask = { threadId: "th1", title: "Phone to session", brief: "A sequence diagram of how a prompt goes from the phone to a session.", tier: "standard" as const };

describe("drawings (G3)", () => {
  it("draws with a worker, renders the version and posts its card; Duck's report is short", async () => {
    const s = setup();
    const r = await s.drawings.draw({ ...ask, kind: "mermaid", surface: "phone" });
    expect(r.how).toBe("started");
    expect(r.task).toMatchObject({ kind: "drawing", state: "running" });
    expect(s.briefs[0]).toContain(`drawings/${r.drawing.id}/v1.mmd`);
    expect(s.briefs[0]).toContain("Readable at 400 px wide");
    expect(r.drawing.pending).toMatchObject({ n: 1 });
    expect(last(s.events)?.d.pending).toEqual({ n: 1, waiting: null });

    s.worker(r.task, r.drawing, 1, "sequenceDiagram\n  Phone->>Server: prompt");
    await s.turnEnds(r.task);
    const d = s.drawings.get(r.drawing.id)!;
    expect(d).toMatchObject({ kind: "mermaid", pending: null });
    expect(d.versions).toEqual([expect.objectContaining({ n: 1, ext: "mmd", headline: "Version 1.", png: expect.objectContaining({ name: "phone-to-session-v1.png" }) })]);
    // The record keeps no thumbnail; the card has it.
    expect(d.versions[0].png).not.toHaveProperty("thumb");
    expect(s.notices).toEqual([expect.objectContaining({ kind: "drawing", drawing: expect.objectContaining({ id: d.id, n: 1, png: expect.objectContaining({ thumb: expect.any(String) }) }) })]);
    // The canvas opens where it was asked for.
    expect(last(s.events)).toMatchObject({ open: "phone", d: { pending: null, versions: [{ n: 1 }] } });
    expect(s.told).toEqual([expect.stringMatching(/version 1, is drawn: Version 1\. It's on the canvas, open on the user's phone\./)]);
    expect(await s.drawings.svg(d.id, 1)).toContain("Phone->>Server");
  });

  it("sends an edit to the thread's warm worker as the next version", async () => {
    const s = setup();
    const r = await s.drawings.draw(ask);
    s.worker(r.task, r.drawing, 1, "sequenceDiagram\n  A->>B: one");
    await s.turnEnds(r.task);
    const sent = () => s.port.calls.filter((c) => c.name === "sendPrompt").map((c) => c.args[1] as string);
    const before = sent().length;

    const e = await s.drawings.draw({ ...ask, brief: "Add the trust check between them.", drawing: r.drawing.id });
    expect(e.how).toBe("followup");
    expect(e.task.id).toBe(r.task.id);
    const prompt = sent()[before];
    expect(prompt).toContain("Add the trust check");
    expect(prompt).toContain(`drawings/${r.drawing.id}/v2.mmd`);
    expect(prompt).toContain("The latest version is");
    await expect(s.drawings.draw({ ...ask, drawing: r.drawing.id })).rejects.toThrow("being drawn already");

    s.worker(r.task, r.drawing, 2, "sequenceDiagram\n  A->>T: check\n  T->>B: ok");
    await s.turnEnds(r.task);
    expect(s.drawings.get(r.drawing.id)!.versions.map((v) => v.n)).toEqual([1, 2]);
    expect(s.told[1]).toContain("version 2, is drawn");
  });

  it("starts a new worker when the warm one is gone", async () => {
    const s = setup();
    const r = await s.drawings.draw(ask);
    s.worker(r.task, r.drawing, 1, "flowchart LR\n  a-->b");
    await s.turnEnds(r.task);
    await s.tasks.close(r.task.id);
    const e = await s.drawings.draw({ ...ask, brief: "Bigger.", drawing: r.drawing.id });
    expect(e.how).toBe("started");
    expect(e.task.id).not.toBe(r.task.id);
    expect(s.briefs[1]).toContain(`drawings/${r.drawing.id}/v2.mmd`);
    expect(s.briefs[1]).toContain(r.drawing.id);
  });

  it("sends a version that doesn't render back once, then reports the failure", async () => {
    let fail = 2;
    const s = setup({ render: () => (fail-- > 0 ? Promise.reject(new Error("Parse error on line 2")) : Promise.resolve("<svg/>")) });
    const r = await s.drawings.draw(ask);
    s.worker(r.task, r.drawing, 1, "flowchart LR\n  a-->");
    await s.turnEnds(r.task);
    expect(s.told).toEqual([]);
    const fix = s.port.calls.filter((c) => c.name === "sendPrompt").map((c) => c.args[1] as string).pop()!;
    expect(fix).toMatch(/doesn't render: Parse error on line 2\. Fix it/);
    expect(s.drawings.get(r.drawing.id)!.pending).toMatchObject({ fixed: true });

    s.worker(r.task, r.drawing, 1, "flowchart LR\n  a--");
    await s.turnEnds(r.task);
    expect(s.told).toEqual([expect.stringContaining("didn't render (Parse error on line 2), even after a fix")]);
    expect(s.drawings.get(r.drawing.id)).toMatchObject({ pending: null, versions: [] });
  });

  it("takes an API worker's source from its result.md", async () => {
    const s = setup();
    const r = await s.drawings.draw({ ...ask, kind: "vega" });
    s.advance(1000);
    s.results.set(r.task.folder, {
      json: JSON.stringify({ status: "done", headline: "Sales by city.", question: null }),
      jsonModified: s.now(),
      md: "# Sales\n\n```json\n{\"mark\":\"bar\"}\n```\n",
    });
    await s.turnEnds(r.task);
    expect(s.written).toEqual([`${r.task.folder}\\drawings\\${r.drawing.id}\\v1.json`]);
    expect(s.rendered).toEqual(['vega:{"mark":"bar"}']);
    expect(s.drawings.get(r.drawing.id)!.versions).toHaveLength(1);
  });

  it("keeps the thread's drawing worker warm while a canvas shows one of its drawings", async () => {
    const s = setup();
    const r = await s.drawings.draw(ask);
    s.worker(r.task, r.drawing, 1, "flowchart LR\n  a-->b");
    await s.turnEnds(r.task);
    const t = s.tasks.get(r.task.id)!;
    expect(s.drawings.keepWarm(t)).toBe(false);
    s.drawings.viewing("desktop", r.drawing.id);
    expect(s.drawings.keepWarm(t)).toBe(true);
    s.drawings.viewing("desktop", null);
    expect(s.drawings.keepWarm(t)).toBe(false);
  });

  it("the draw tool hands the request over with the surface it came from", async () => {
    const s = setup();
    const ctx = { ...toolCtx(s.port), threadId: "th1", drawings: s.drawings, surface: "desktop" as const };
    const out = await draw.run({ title: "Cache", brief: "Boxes: app, cache, DB.", tier: "standard" }, ctx);
    expect(out).toMatchObject({ version: 1, worker: "a new drawing worker" });
    const d = s.drawings.list("th1")[0];
    expect(d).toMatchObject({ title: "Cache", surface: "desktop" });
    await expect(draw.run({ title: "x", brief: "y", tier: "standard", files: ["nope"] }, ctx)).rejects.toThrow("no file nope");
    expect(() => draw.schema.parse({ title: "x", brief: "y", kind: "html" })).toThrow();
  });
});
