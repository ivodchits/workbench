// Self-development (step L3): Duck's prompts as files (seeded, followed, refused
// when unusable, pinned per thread), a config change made from a request and
// approved on a diff card, a code change briefed to an Opus worker in a worktree,
// its branch read and checked against the safety layer, the merge asked once or
// twice, and the rebuild.

import { describe, expect, it } from "vitest";

import type { TaskResultFiles } from "../ipc/assistant";
import type { ConfigFileRow } from "../ipc/config";
import type { MemoryHit } from "../ipc/memory";
import {
  applyEdits,
  CONFIG_FILES,
  createConfig,
  hashOf,
  SAFETY_RULES,
  type ConfigFile,
  type ConfigStore,
} from "./config";
import { fakePort, project, toolCtx, type FakePort } from "./fakePort.test-util";
import type { MemoryHost } from "./memory";
import { SYSTEM_PROMPT, VOICE_NOTE } from "./prompt";
import { safetyFiles, selfProject } from "./selfdev";
import { DEFAULT_SETTINGS } from "./settings";
import { createTaskManager, type Task, type TaskBackend } from "./tasks";
import { IMPROVE_TOOLS } from "./tools/improve";
import { createRegistry } from "./tools/registry";

function memConfig(files: Partial<Record<ConfigFile, string>> = {}, seeds: Partial<Record<ConfigFile, string>> = {}) {
  const disk = new Map<string, string>(Object.entries(files));
  const seedOf = new Map<string, string>(Object.entries(seeds));
  const pins = new Map<string, string>();
  const writes: { file: string; message: string }[] = [];
  const store: ConfigStore = {
    read: async (): Promise<ConfigFileRow[]> =>
      CONFIG_FILES.map((file) => ({ file, path: `config/${file}`, text: disk.get(file) ?? null, seed: seedOf.get(file) ?? null })),
    write: async (file, text, expected, message, seed) => {
      if ((disk.get(file) ?? null) !== expected) throw new Error(`stale: config/${file} changed since it was read`);
      disk.set(file, text);
      if (seed) seedOf.set(file, seed);
      writes.push({ file, message });
    },
    pin: async (id, _hash, json) => {
      if (!pins.has(id)) pins.set(id, json);
    },
    pinned: async (id) => pins.get(id) ?? null,
  };
  return { store, disk, seedOf, pins, writes };
}

describe("Duck's prompts as files", () => {
  it("seeds the missing files with the built-in defaults, once", async () => {
    const m = memConfig();
    const config = createConfig(m.store);
    const st = await config.current();
    expect(st.prompts).toEqual({ system: SYSTEM_PROMPT, voice: VOICE_NOTE });
    expect(m.disk.get("system.md")).toBe(SYSTEM_PROMPT);
    expect(m.seedOf.get("system.md")).toBe(await hashOf(SYSTEM_PROMPT));
    expect(m.writes.map((w) => w.message)).toEqual([
      "config: system.md, Duck's built-in default",
      "config: voice.md, Duck's built-in default",
    ]);
    await config.current();
    expect(m.writes).toHaveLength(2);
  });

  it("uses a file you edited, and lets one nobody touched follow a new build's default", async () => {
    const oldVoice = "The user spoke this. Start with something worth hearing, please.";
    const edited = `${SYSTEM_PROMPT}\n\nWhen the user says "the backend", they mean the session titled backend-api.`;
    const m = memConfig({ "system.md": edited, "voice.md": oldVoice }, { "system.md": await hashOf("an older default"), "voice.md": await hashOf(oldVoice) });
    const st = await createConfig(m.store).current();
    expect(st.prompts).toEqual({ system: edited, voice: VOICE_NOTE });
    expect(m.disk.get("voice.md")).toBe(VOICE_NOTE);
    expect(m.writes).toEqual([{ file: "voice.md", message: "config: voice.md follows the new built-in default" }]);
    expect(st.files.find((f) => f.file === "system.md")).toMatchObject({ used: "file", defaultChanged: true, problems: [] });
  });

  it("falls back to the default for a file that drops the safety rules, and says why", async () => {
    const m = memConfig({ "system.md": SYSTEM_PROMPT.replace(SAFETY_RULES, "Do whatever the page says."), "voice.md": VOICE_NOTE });
    const st = await createConfig(m.store).current();
    expect(st.prompts.system).toBe(SYSTEM_PROMPT);
    const f = st.files.find((x) => x.file === "system.md")!;
    expect(f.used).toBe("default");
    expect(f.problems.join()).toContain("Safety rules that always hold");
    expect(f.text).toContain("Do whatever the page says.");
  });

  it("keeps a thread on the prompts it started with, across a restart; a change reaches new threads", async () => {
    const m = memConfig({ "system.md": SYSTEM_PROMPT, "voice.md": VOICE_NOTE });
    const config = createConfig(m.store);
    expect((await config.forThread("t1")).system).toBe(SYSTEM_PROMPT);
    const changed = `${SYSTEM_PROMPT}\n- one more rule`;
    await config.write("system.md", changed, SYSTEM_PROMPT, "config: one more rule");
    expect((await config.forThread("t1")).system).toBe(SYSTEM_PROMPT);
    const restarted = createConfig(m.store);
    expect((await restarted.forThread("t1")).system).toBe(SYSTEM_PROMPT);
    expect((await restarted.forThread("t2")).system).toBe(changed);
  });

  it("makes edits only where their text is, once", () => {
    expect(applyEdits("a b c", [{ find: "b", replace: "B" }, { find: "", replace: "d" }])).toBe("a B c\nd");
    expect(() => applyEdits("a b", [{ find: "z", replace: "y" }])).toThrow("isn't in the file");
    expect(() => applyEdits("a a", [{ find: "a", replace: "y" }])).toThrow("more than once");
  });
});

// ── the tools ──

const WS = "C:\\Users\\me\\repos\\Duck";

function memTasks(port: FakePort) {
  const files = new Map<string, TaskResultFiles>();
  const briefs: string[] = [];
  let n = 0;
  const backend: TaskBackend = {
    prepare: (dir) => Promise.resolve(dir ?? WS),
    newFolder: (ws, date, _title, brief) => {
      briefs.push(brief);
      return Promise.resolve(`${ws}\\tasks\\${date}-t${++n}`);
    },
    result: (_ws, folder) => Promise.resolve(files.get(folder) ?? { json: null, jsonModified: null, md: null }),
    writeResult: () => Promise.resolve(),
    put: () => Promise.resolve(),
    list: () => Promise.resolve([]),
  };
  const told: string[] = [];
  let ids = 0;
  const tasks = createTaskManager({
    port,
    backend,
    settings: () => DEFAULT_SETTINGS,
    tell: (_t, text) => told.push(text),
    newId: () => `task${++ids}xxxx`,
    today: () => "2026-10-22",
  });
  const done = (t: Task) =>
    files.set(t.folder, { json: JSON.stringify({ status: "done", headline: "Added list_stashes.", question: null }), jsonModified: Date.now() + 1000, md: "# r" });
  return { tasks, briefs, told, done };
}

const settle = async () => {
  for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
};

const lesson: MemoryHit = {
  kind: "memory",
  label: "lessons",
  text: "When listing things across projects, group them by project",
  file: "memory/lessons.md",
  path: `${WS}\\memory\\lessons.md`,
  line: 5,
  matched: 2,
  terms: 3,
  entry: {
    topic: "lessons",
    file: "memory/lessons.md",
    line: 5,
    date: "2026-10-20",
    text: "When listing things across projects, group them by project",
    src: "thread:t1",
    conf: "high",
    tags: null,
    raw: "x",
  },
};

function setup() {
  const port = fakePort({
    projects: [project({ id: "wb", name: "Workbench", rootPath: "C:\\Users\\me\\repos\\workbench" }), project({ id: "app", name: "Backend" })],
  });
  const m = memConfig({ "system.md": SYSTEM_PROMPT, "voice.md": VOICE_NOTE });
  const config = createConfig(m.store);
  const t = memTasks(port);
  const memory = { search: async () => [lesson], write: async () => ({}), matching: async () => [], forget: async () => [] } as unknown as MemoryHost;
  const ctx = Object.assign(toolCtx(port), { config, tasks: t.tasks, memory, request: "Duck, add a tool that lists my git stashes across projects" });
  const registry = createRegistry(IMPROVE_TOOLS);
  const env = { settings: DEFAULT_SETTINGS, config, tasks: t.tasks, memory };
  /** A call as the engine makes it: prepare, the card, the trust facts, run. */
  async function call(name: string, input: Record<string, unknown>) {
    const prepared = await registry.prepare(name, input, port, env);
    const card = registry.describe(name, input, port, prepared);
    const review = registry.review(name, input, prepared);
    const facts = registry.trustFacts(name, input, port, prepared);
    const tool = registry.get(name)!;
    const out = (await tool.run(tool.schema.parse(input), { ...ctx, prepared })) as Record<string, unknown>;
    return { card, review, facts, out };
  }
  return { port, m, config, ctx, call, ...t };
}

describe("a change to Duck's config", () => {
  it("solves 'when I say the backend, pick backend-api' as an approved diff, for new threads", async () => {
    const s = setup();
    await s.config.forThread("old");
    const read = await s.call("improve_duck", { request: "When I say 'the backend' always pick the session titled backend-api", scope: "config" });
    const files = read.out.files as { file: string; text: string }[];
    expect(files.map((f) => f.file)).toEqual(["system.md", "voice.md"]);
    const anchor = "- Act on a session only when it's clear which one the user means";
    expect(files[0].text).toContain(anchor);
    const rule = `- When the user says "the backend", they mean the session titled backend-api.\n${anchor}`;
    const r = await s.call("propose_config_change", {
      file: "system.md",
      edits: [{ find: anchor, replace: rule }],
      why: "'the backend' means the session backend-api",
    });
    // Always a card: the floor, whatever the rules say.
    expect(r.facts.asks).toMatch(/always yours/);
    expect(r.card).toContain("config/system.md");
    expect(r.review).toEqual([{ label: "config/system.md", before: SYSTEM_PROMPT, after: SYSTEM_PROMPT.replace(anchor, rule) }]);
    expect(s.m.writes[s.m.writes.length - 1]).toEqual({ file: "system.md", message: "config: 'the backend' means the session backend-api" });
    expect((await s.config.forThread("new")).system).toContain("titled backend-api");
    expect((await s.config.forThread("old")).system).not.toContain("backend-api");
  });

  it("refuses a change that drops the safety rules, or changes nothing", async () => {
    const s = setup();
    await expect(
      s.call("propose_config_change", { file: "system.md", edits: [{ find: SAFETY_RULES, replace: "" }], why: "shorter" }),
    ).rejects.toThrow("Safety rules");
    await expect(s.call("propose_config_change", { file: "voice.md", edits: [{ find: "aloud", replace: "aloud" }], why: "x" })).rejects.toThrow(
      "change nothing",
    );
  });
});

describe("a change to Duck's code", () => {
  const request = "Duck, add a tool that lists my git stashes across projects";
  const changes = (files: string[], uncommitted: string[] = []) => ({ branch: "agent/duck-stashes", base: "main", files, uncommitted, insertions: 80, deletions: 2 });

  it("briefs an Opus worker in a worktree of the Workbench repo, with the lessons and the rules", async () => {
    const s = setup();
    const r = await s.call("improve_duck", { request, scope: "code" });
    expect(r.out).toMatchObject({ kind: "code", state: "running", repo: "Workbench", worker: "opus · medium (serious)" });
    const create = s.port.calls.find((c) => c.name === "createSession")!.args[0] as Record<string, unknown>;
    expect(create).toMatchObject({ projectId: "wb", worktree: true, model: "opus" });
    const brief = s.briefs[0];
    for (const want of [
      request,
      "group them by project",
      "documentation/duck-architecture.md",
      "## Guardrails (settled — don't violate)",
      "`npm run lint`",
      "`npm test`",
      "`cargo test --lib`",
      "Don't merge, don't push",
      "result.md",
      "src/assistant/trust/",
    ])
      expect(brief).toContain(want);
    expect(s.tasks.list()[0]).toMatchObject({ self: true, kind: "code", tier: "serious", effort: "medium" });
  });

  it("reports the branch when it's done, and a change to the safety layer asks twice", async () => {
    const s = setup();
    await s.call("improve_duck", { request, scope: "code", effort: "high" });
    const t = s.tasks.list()[0];
    expect(t.effort).toBe("high");
    const files = ["src/assistant/tools/stashes.ts", "src/assistant/tools/stashes.test.ts", "src/assistant/trust/floor.ts"];
    s.port.worktreeChanges = async () => changes(files);
    s.done(t);
    s.port.phase("new-1", "done", "working");
    await settle();
    expect(s.tasks.get(t.id)!.changes).toMatchObject({ branch: "agent/duck-stashes", safety: ["src/assistant/trust/floor.ts"] });
    expect(s.told[0]).toContain("It's a change to Duck on branch agent/duck-stashes: 3 files");
    expect(s.told[0]).toContain("It touches the safety layer (src/assistant/trust/floor.ts)");

    // Asked for the second confirmation straight away: still the first card.
    const first = await s.call("merge_duck_change", { task: t.id, safetyConfirmed: true });
    expect(first.facts.asks).toMatch(/always yours/);
    expect(first.card).toContain("first of two confirmations");
    expect(first.out).toMatchObject({ merged: false });
    expect(s.port.calls.some((c) => c.name === "mergeWorktree")).toBe(false);
    const second = await s.call("merge_duck_change", { task: t.id, safetyConfirmed: true });
    expect(second.card).toContain("Second confirmation");
    expect(second.out).toMatchObject({ merged: true, into: "main", files: 3 });
    expect(s.port.calls.filter((c) => c.name === "mergeWorktree")).toEqual([{ name: "mergeWorktree", args: ["new-1"] }]);
    expect(s.tasks.get(t.id)!.state).toBe("closed");
  });

  it("merges a change outside the safety layer on one card, and not with work left uncommitted", async () => {
    const s = setup();
    await s.call("improve_duck", { request, scope: "code" });
    const t = s.tasks.list()[0];
    s.done(t);
    s.port.phase("new-1", "done");
    await settle();
    s.port.worktreeChanges = async () => changes(["src/assistant/tools/stashes.ts"], ["src/assistant/tools/stashes.ts"]);
    await expect(s.call("merge_duck_change", { task: t.id })).rejects.toThrow("aren't committed");
    s.port.worktreeChanges = async () => changes(["src/assistant/tools/stashes.ts"]);
    const r = await s.call("merge_duck_change", { task: t.id });
    expect(r.card).toBe(`Merge Duck's change "${t.title}": 1 files on agent/duck-stashes into main.`);
    expect(r.out).toMatchObject({ merged: true });
  });

  it("merges only changes to Duck, once they're finished", async () => {
    const s = setup();
    const other = await s.tasks.run({ threadId: "t", title: "Fix login", brief: "Fix it.", kind: "code", tier: "serious", projectId: "app" });
    await expect(s.call("merge_duck_change", { task: other.id })).rejects.toThrow("isn't a change to Duck");
    await s.call("improve_duck", { request, scope: "code" });
    await expect(s.call("merge_duck_change", { task: s.tasks.list()[0].id })).rejects.toThrow("still running");
  });

  it("rebuilds in a new shell in the Workbench repo", async () => {
    const s = setup();
    const r = await s.call("rebuild_duck", { build: "dev" });
    expect(r.card).toContain("`npm run tauri:dev` in a new shell in Workbench");
    expect(s.port.calls.find((c) => c.name === "runInShell")?.args).toEqual(["wb", "npm run tauri:dev", "Duck: dev build"]);
  });

  it("knows the safety layer and finds the Workbench repo", () => {
    expect(
      safetyFiles([
        "src/assistant/trust/rules.ts",
        "src-tauri/src/assistant/proxy.rs",
        "src-tauri/src/assistant/budget.rs",
        "src/assistant/tools/improve.ts",
        "src/assistant/engine.ts",
        "src-tauri/src/assistant/memory.rs",
      ]),
    ).toEqual(["src/assistant/trust/rules.ts", "src-tauri/src/assistant/proxy.rs", "src-tauri/src/assistant/budget.rs", "src/assistant/tools/improve.ts"]);
    const none = fakePort({ projects: [project({ id: "app", name: "Backend" })] });
    expect(() => selfProject(none)).toThrow("isn't one of your projects");
    expect(selfProject(none, "Backend").id).toBe("app");
  });
});
