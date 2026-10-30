import { afterEach, describe, expect, it, vi } from "vitest";

import {
  fakePort,
  project,
  session,
  toolCtx,
  type FakePortData,
} from "../fakePort.test-util";
import { createPolicy } from "../policy";
import type { ChoiceRef } from "../port";
import { DEFAULT_SETTINGS } from "../settings";
import {
  ACT_TOOLS,
  answerChoice,
  appendNote,
  clearWatches,
  createSession,
  deleteNote,
  disposeWorktree,
  lossOf,
  filesLine,
  killSession,
  resumeSession,
  sendPrompt,
  ALREADY_GRACE_MS,
  waitForSession,
  writeNote,
} from "./act";
import { createRegistry, type ToolDef } from "./registry";

const choice: ChoiceRef = {
  id: "c7",
  kind: "permission",
  toolName: "Bash",
  input: { command: "npm test" },
  at: 0,
  questions: [],
  options: [
    { key: 1, label: "Yes", detail: "", typed: false },
    { key: 2, label: "No", detail: "", typed: false },
  ],
  terminalOnly: null,
  sent: null,
  optionsFrom: "terminal",
  held: false,
};

function data(): FakePortData {
  return {
    projects: [
      project({ id: "p1", name: "Backend" }),
      project({ id: "p2", name: "Box", remote: true }),
    ],
    sessions: [
      session({ id: "i1", projectId: "p1", title: "api", phase: "needs_you", choice }),
      session({ id: "i2", projectId: "p1", title: "tests", phase: "working" }),
      session({ id: "i3", projectId: "p1", title: "old", phase: "offline" }),
    ],
    notes: {
      p1: [{ id: "plan", modified: 5, size: 6, content: "# Plan\n" }],
    },
  };
}

async function run(
  tool: ToolDef,
  input: unknown,
  opts: { d?: FakePortData; settings?: Partial<typeof DEFAULT_SETTINGS> } = {},
) {
  const port = fakePort(opts.d ?? data());
  const ctx = toolCtx(port, opts.settings);
  const out = (await tool.run(tool.schema.parse(input), ctx)) as Record<string, unknown>;
  return { out, port, ctx };
}

afterEach(() => {
  clearWatches();
  vi.useRealTimers();
});

describe("action tools", () => {
  it("register with valid schemas and the planned tiers", () => {
    const r = createRegistry(ACT_TOOLS);
    const port = fakePort(data());
    const tier = (name: string, input: unknown) => r.callTier(name, input, port);
    expect(tier("send_prompt", { session: "api", text: "hi" })).toBe("reversible");
    expect(tier("create_session", { project: "Backend" })).toBe("reversible");
    expect(tier("open_panel", { project: "Backend", kind: "git" })).toBe("reversible");
    expect(tier("append_note", { project: "Backend", name: "plan", text: "x" })).toBe(
      "reversible",
    );
    for (const name of [
      "answer_choice",
      "interrupt_session",
      "stop_session",
      "kill_session",
      "write_note",
      "delete_note",
    ])
      expect(r.tierOf(name)).toBe("consequential");
    // Resuming over a running session ends its process: that one asks.
    expect(tier("resume_session", { session: "tests" })).toBe("consequential");
    expect(tier("resume_session", { session: "old" })).toBe("reversible");
  });

  it("send_prompt finds the session by title and says where the prompt went", async () => {
    const { out, port } = await run(sendPrompt, { session: "tests", text: "run the suite" });
    expect(port.calls).toEqual([{ name: "sendPrompt", args: ["i2", "run the suite"] }]);
    expect(out.delivery).toMatch(/^sent/);
    const queued = await run(sendPrompt, { session: "api", text: "x" }, {
      d: { ...data(), delivery: "queued" },
    });
    expect(queued.out.delivery).toMatch(/^queued: .*together with anything else waiting/);
  });

  it("send_prompt copies the thread's files into the session's folder and names their paths", async () => {
    const shot = { id: "f1", name: "shot.png", mime: "image/png", size: 10 };
    const spec = { id: "f2", name: "spec.pdf", mime: "application/pdf", size: 20 };
    const port = fakePort(data());
    const copied: { dir: string; names: string[] }[] = [];
    const ctx = {
      ...toolCtx(port),
      attachment: (id: string) => [shot, spec].find((f) => f.id === id),
      toSession: (dir: string, files: readonly { name: string }[]) => {
        copied.push({ dir, names: files.map((f) => f.name) });
        return Promise.resolve(files.map((f) => `${dir}/.duck-attachments/${f.name}`));
      },
    };
    const input = sendPrompt.schema.parse({ session: "tests", text: "fix the overlap", files: ["f1", "f2", "f1"] });
    const out = (await sendPrompt.run(input, ctx)) as { files: string[] };
    expect(copied).toEqual([{ dir: "C:/src/p1", names: ["shot.png", "spec.pdf"] }]);
    const paths = ["C:/src/p1/.duck-attachments/shot.png", "C:/src/p1/.duck-attachments/spec.pdf"];
    expect(port.calls).toEqual([
      { name: "sendPrompt", args: ["i2", `fix the overlap\n\n${filesLine(paths)}`] },
    ]);
    expect(filesLine(paths)).toBe(`Attached files (read with your Read tool):\n- ${paths[0]}\n- ${paths[1]}`);
    expect(out.files).toEqual(paths);
    expect(sendPrompt.describe!(input, port, undefined)).toBe('Send to "tests" with 2 files: fix the overlap');

    // A file the thread doesn't have, and a session on another machine, send nothing.
    await expect(
      sendPrompt.run(sendPrompt.schema.parse({ session: "tests", text: "x", files: ["nope"] }), ctx),
    ).rejects.toThrow(/no file nope/);
    const remote = fakePort({
      ...data(),
      sessions: [session({ id: "r1", projectId: "p2", title: "box", phase: "idle" })],
    });
    await expect(
      sendPrompt.run(sendPrompt.schema.parse({ session: "box", text: "x", files: ["f1"] }), {
        ...ctx,
        port: remote,
      }),
    ).rejects.toThrow(/another machine/);
    expect(remote.calls).toEqual([]);
    expect(copied).toHaveLength(1);
  });

  it("create_session hands a session over to Duck only on the user's own words (T3)", async () => {
    const request = "Start a session to tidy the logging, and handle its questions yourself.";
    const port = fakePort(data());
    const ctx = { ...toolCtx(port), request };
    const out = (await createSession.run(
      createSession.schema.parse({ project: "backend", delegatedBy: "handle its questions yourself" }),
      ctx,
    )) as { delegated: string };
    expect(port.calls[0].args[0]).toMatchObject({ mandate: { text: request, threadId: "t", delegated: true } });
    expect(out.delegated).toMatch(/^yes/);
    // Words the user didn't say don't hand it over.
    const other = fakePort(data());
    const refused = (await createSession.run(
      createSession.schema.parse({ project: "backend", delegatedBy: "answer everything for me" }),
      { ...toolCtx(other), request },
    )) as { delegated: string };
    expect(other.calls[0].args[0]).toMatchObject({ mandate: { text: request, threadId: "t" } });
    expect((other.calls[0].args[0] as { mandate: object }).mandate).not.toHaveProperty("delegated");
    expect(refused.delegated).toMatch(/^no/);
  });

  it("create_session runs coding work on the coding model unless told otherwise", async () => {
    const coding = await run(
      createSession,
      { project: "backend", prompt: "fix the failing test" },
      { settings: { codingModel: "opus" } },
    );
    expect(coding.port.calls[0].args[0]).toMatchObject({
      projectId: "p1",
      prompt: "fix the failing test",
      model: "opus",
    });
    expect(coding.out.prompt).toMatch(/once Claude Code is ready/);
    // No user message here, so no mandate; with one, it's stored for the judge.
    expect(coding.port.calls[0].args[0]).toMatchObject({ mandate: undefined });
    const port = fakePort(data());
    const ctx = { ...toolCtx(port), request: "fix the failing auth test in backend" };
    await createSession.run(createSession.schema.parse({ project: "backend" }), ctx);
    expect(port.calls[0].args[0]).toMatchObject({
      mandate: { text: "fix the failing auth test in backend", threadId: "t" },
    });

    const inherit = await run(createSession, { project: "Backend", model: "project" });
    expect(inherit.port.calls[0].args[0]).toMatchObject({ model: null });
    expect(inherit.out.model).toBe("the project's default");
    expect(inherit.port.calls[0].args[0]).toMatchObject({ permissionMode: null });

    // The permission mode follows the same rule (step M4).
    const mode = await run(
      createSession,
      { project: "backend" },
      { settings: { codingPermissionMode: "acceptEdits" } },
    );
    expect(mode.port.calls[0].args[0]).toMatchObject({ permissionMode: "acceptEdits" });
    const plan = await run(
      createSession,
      { project: "backend", permissionMode: "plan" },
      { settings: { codingPermissionMode: "acceptEdits" } },
    );
    expect(plan.port.calls[0].args[0]).toMatchObject({ permissionMode: "plan" });
    await expect(
      run(createSession, { project: "backend", permissionMode: "bypassPermissions" }),
    ).rejects.toThrow();

    await expect(run(createSession, { project: "Box", worktree: true })).rejects.toThrow(
      /remote project/,
    );
  });

  it("answer_choice describes the answer for the card and refuses a stale prompt", async () => {
    const r = createRegistry(ACT_TOOLS);
    const port = fakePort(data());
    expect(
      r.describe("answer_choice", { session: "api", choiceId: "c7", option: 1 }, port),
    ).toBe('Answer "api" — permission: Bash npm test — with: 1. Yes');
    expect(
      r.describe("answer_choice", { session: "api", choiceId: "c7", option: "deny" }, port),
    ).toMatch(/with: deny$/);

    const { out } = await run(answerChoice, { session: "api", choiceId: "c7", option: 1 });
    expect(out).toEqual({ session: "api", answered: "Yes" });
    // Models send the key as a string as often as a number.
    const str = await run(answerChoice, { session: "api", choiceId: "c7", option: "2" });
    expect(str.port.calls[0].args).toEqual(["i1", "c7", 2]);
    const deny = await run(answerChoice, { session: "api", choiceId: "c7", option: "Deny" });
    expect(deny.port.calls[0].args).toEqual(["i1", "c7", "deny"]);
    await expect(
      run(answerChoice, { session: "api", choiceId: "c6", option: 1 }),
    ).rejects.toThrow(/no longer open/);
  });

  it("kill_session removes the session, and refuses one with a worktree", async () => {
    const d = data();
    d.sessions!.push(session({ id: "i4", projectId: "p1", title: "wt", worktreeBranch: "wb/4" }));
    const { out, port } = await run(killSession, { session: "old" }, { d });
    expect(port.calls).toEqual([{ name: "killSession", args: ["i3"] }]);
    expect(out).toEqual({ session: "old", killed: true });
    expect(port.listSessions().map((s) => s.id)).not.toContain("i3");
    await expect(run(killSession, { session: "wt" }, { d })).rejects.toThrow(/worktree/);
  });

  describe("dispose_worktree", () => {
    const clean = { worktree: "C:/wt/x", branch: "agent/x", base: "main", unmerged: 0, commits: [], dirty: [] };
    const lossy = { ...clean, unmerged: 2, commits: ["abc123 half the fix", "def456 wip"], dirty: ["src/a.ts"] };
    const withWt = (loss: typeof clean) => {
      const d = data();
      d.sessions!.push(session({ id: "i4", projectId: "p1", title: "wt", worktreeBranch: "agent/x" }));
      d.losses = { i4: loss };
      return d;
    };
    const r = createRegistry(ACT_TOOLS);
    /** The call as the engine makes it: prepare, the tier, the card, then run. */
    async function call(input: object, d: FakePortData, request: string | null = null) {
      const port = fakePort(d);
      const prepared = await disposeWorktree.prepare!(disposeWorktree.schema.parse(input), port);
      const tier = r.callTier("dispose_worktree", input, port, prepared);
      const card = disposeWorktree.describe!(disposeWorktree.schema.parse(input), port, prepared);
      const ctx = { ...toolCtx(port), request, prepared };
      const out = (await disposeWorktree.run(disposeWorktree.schema.parse(input), ctx)) as Record<string, unknown>;
      return { port, tier, card, out };
    }

    it("removes a merged, clean worktree at once and says what went", async () => {
      const { port, tier, card, out } = await call({ session: "wt" }, withWt(clean));
      expect(tier).toBe("reversible");
      expect(card).toBe('End "wt", remove its worktree and delete agent/x (merged into main, nothing uncommitted)');
      expect(port.calls).toEqual([{ name: "disposeWorktree", args: ["i4", false] }]);
      expect(out).toEqual({
        session: "wt",
        removed: { worktree: "C:/wt/x", branch: "agent/x", session: true },
        checkedAgainst: "main",
        lost: "nothing: the branch was merged and the worktree clean",
      });
      expect(port.listSessions().map((s) => s.id)).not.toContain("i4");
    });

    it("refuses unmerged or dirty work, naming it, before any card", async () => {
      const unforced = call({ session: "wt" }, withWt(lossy));
      await expect(unforced).rejects.toThrow(
        "Not removed: 2 commits on agent/x not in main (abc123 half the fix; def456 wip), and 1 uncommitted or untracked file (src/a.ts).",
      );
      // force alone isn't enough: it needs the user's words.
      await expect(call({ session: "wt", force: true }, withWt(lossy))).rejects.toThrow(/needs the user's own words/);
      expect(lossOf(clean)).toBeNull();
    });

    it("forces it only on the user's own words, and the card says what it destroys", async () => {
      const words = "remove the wt worktree even though it isn't merged";
      const request = `Ok, ${words}, I don't need that work.`;
      const { port, tier, card, out } = await call({ session: "wt", force: true, grantedBy: words }, withWt(lossy), request);
      expect(tier).toBe("consequential");
      expect(card).toMatch(/DESTROYING 2 commits on agent\/x not in main .*src\/a\.ts/);
      expect(port.calls).toEqual([{ name: "disposeWorktree", args: ["i4", true] }]);
      expect(out.lost).toMatch(/^2 commits/);
      // Words the user didn't say force nothing.
      const said = call({ session: "wt", force: true, grantedBy: words }, withWt(lossy), "clean up the sessions");
      await expect(said).rejects.toThrow(/doesn't contain/);
    });
  });

  it("resume_session passes the chosen conversation on", async () => {
    const { port } = await run(resumeSession, { session: "old", sessionId: "s-9" });
    expect(port.calls).toEqual([{ name: "resumeSession", args: ["i3", "s-9"] }]);
  });
});

describe("answer_choice inputs", () => {
  it("takes a typed answer, and its card says what will be typed", async () => {
    const { out, port } = await run(answerChoice, {
      session: "api",
      choiceId: "c7",
      text: "  white ",
    });
    expect(port.calls[0].args).toEqual(["i1", "c7", { text: "white" }]);
    expect(out.answered).toBe("white");
    expect(
      createRegistry(ACT_TOOLS).describe(
        "answer_choice",
        { session: "api", choiceId: "c7", text: "white" },
        fakePort(data()),
      ),
    ).toMatch(/with: typed answer "white"$/);
  });

  it("fails schema validation when it names no answer, so no card is shown", () => {
    const bad = [
      { session: "api", choiceId: "c7" },
      { session: "api", choiceId: "c7", option: "yes please" },
      { session: "api", choiceId: "c7", option: 1, text: "white" },
      { session: "api", choiceId: "c7", option: 12 },
    ];
    for (const input of bad)
      expect(answerChoice.schema.safeParse(input).success, JSON.stringify(input)).toBe(false);
    expect(answerChoice.schema.safeParse({ session: "a", choiceId: "c", option: "3" }).success).toBe(
      true,
    );
  });
});

describe("wait_for_session", () => {
  it("posts one event when the session finishes, ignoring other sessions", async () => {
    const { out, port, ctx } = await run(waitForSession, { session: "tests", until: "done" });
    expect(out).toMatchObject({ watching: "done", forMinutes: 60 });
    port.phase("i1", "done");
    port.phase("i2", "needs_you");
    expect(ctx.posted).toEqual([]);
    port.phase("i2", "done");
    port.phase("i2", "done");
    expect(ctx.posted).toHaveLength(1);
    expect(ctx.posted[0]).toMatch(/^Session "tests" \(Backend, id i2\) is now done\./);
  });

  it("gives up after its timeout, and says when it's already there", async () => {
    vi.useFakeTimers();
    const { port, ctx } = await run(waitForSession, { session: "tests", timeoutMin: 5 });
    vi.advanceTimersByTime(5 * 60_000);
    expect(ctx.posted[0]).toMatch(/still working after 5 minutes/);
    port.phase("i2", "done");
    expect(ctx.posted).toHaveLength(1);

    const already = await run(waitForSession, { session: "api" });
    expect(already.out).toEqual({ session: "api", already: "needs_you" });
    // Just started, no phase yet: it waits rather than refusing.
    const fresh = await run(waitForSession, { session: "old" });
    expect(fresh.out).toMatchObject({ watching: "either" });
  });
});

describe("wait_for_session around compactions and prompts", () => {
  const withSession = (extra: Partial<Parameters<typeof session>[0]>) => {
    const d = data();
    d.sessions!.push(session({ id: "i9", projectId: "p1", title: "plans", phase: "done", ...extra }));
    return d;
  };
  /** Start the tool; it may sleep (the grace before "already"), so time is moved on. */
  async function start(input: unknown, d: FakePortData, before?: (port: ReturnType<typeof fakePort>) => void) {
    vi.useFakeTimers();
    const port = fakePort(d);
    before?.(port);
    const ctx = toolCtx(port);
    const pending = waitForSession.run(waitForSession.schema.parse(input), ctx) as Promise<Record<string, unknown>>;
    await vi.advanceTimersByTimeAsync(ALREADY_GRACE_MS);
    return { out: await pending, port, ctx };
  }

  it("waits out a compaction a finished turn is running, and tells when it ends", async () => {
    const d = withSession({ compacting: true });
    const { out, port, ctx } = await start({ session: "plans", until: "done" }, d);
    expect(out).toMatchObject({ watching: "done" });
    // A phase event while it still compacts isn't the end.
    port.phase("i9", "done", "done");
    expect(ctx.posted).toEqual([]);
    d.sessions!.find((x) => x.id === "i9")!.compacting = false;
    port.compactionEnds("i9", "done");
    expect(ctx.posted).toHaveLength(1);
    expect(ctx.posted[0]).toMatch(/^Session "plans" \(Backend, id i9\) is now done\./);
  });

  it("isn't already done while a prompt of Duck's is still going in", async () => {
    const d = withSession({});
    const { out, port, ctx } = await start({ session: "plans", until: "done" }, d, (p) => p.pending.add("i9"));
    expect(out).toMatchObject({ watching: "done" });
    // The prompt goes in, the turn runs and ends.
    port.pending.delete("i9");
    port.phase("i9", "working", "done");
    port.phase("i9", "done", "working");
    expect(ctx.posted).toHaveLength(1);
  });

  it("sees a prompt sent alongside it start a turn before calling it already done", async () => {
    const d = withSession({});
    const s = d.sessions!.find((x) => x.id === "i9")!;
    vi.useFakeTimers();
    const port = fakePort(d);
    const ctx = toolCtx(port);
    const pending = waitForSession.run(waitForSession.schema.parse({ session: "plans", until: "done" }), ctx) as Promise<Record<string, unknown>>;
    s.phase = "working"; // the prompt sent in the same batch was taken meanwhile
    await vi.advanceTimersByTimeAsync(ALREADY_GRACE_MS);
    expect(await pending).toMatchObject({ watching: "done" });

    const quiet = withSession({});
    expect((await start({ session: "plans", until: "done" }, quiet)).out).toEqual({ session: "plans", already: "done" });
  });

  it("notices on its own look an end its events didn't tell", async () => {
    const d = withSession({ compacting: true });
    const { ctx } = await start({ session: "plans", until: "done" }, d);
    d.sessions!.find((x) => x.id === "i9")!.compacting = false; // no event came
    await vi.advanceTimersByTimeAsync(5_000);
    expect(ctx.posted).toHaveLength(1);
  });
});

describe("notes tools", () => {
  it("append_note adds after a blank line and leaves a chip with both texts", async () => {
    const { out, port, ctx } = await run(appendNote, {
      project: "Backend",
      name: "plan",
      text: "- ship it",
    });
    expect(port.calls[0]).toEqual({
      name: "writeNote",
      args: ["p1", "plan", "# Plan\n\n- ship it\n", "r-5"],
    });
    expect(out).toEqual({ project: "Backend", name: "plan", revision: "r-6" });
    expect(ctx.notices).toEqual([
      {
        kind: "note",
        text: "Duck added to plan",
        note: {
          projectId: "p1",
          project: "Backend",
          name: "plan",
          before: "# Plan\n",
          after: "# Plan\n\n- ship it\n",
          revision: "r-6",
        },
      },
    ]);
  });

  it("write_note refuses an edit made on an old revision", async () => {
    await expect(
      run(writeNote, { project: "Backend", name: "plan", content: "new", baseRevision: "r-4" }),
    ).rejects.toThrow(/^stale: the note changed since you read it/);
    const ok = await run(writeNote, {
      project: "Backend",
      name: "plan",
      content: "new",
      baseRevision: "r-5",
    });
    expect(ok.out.revision).toBe("r-6");
    expect(ok.ctx.notices[0].note).toMatchObject({ before: "# Plan\n", after: "new" });
  });

  it("delete_note keeps the text in its chip for undo", async () => {
    const { port, ctx } = await run(deleteNote, { project: "Backend", name: "plan" });
    expect(port.calls).toEqual([{ name: "deleteNote", args: ["p1", "plan"] }]);
    expect(ctx.notices[0].note).toMatchObject({ before: "# Plan\n", after: null, revision: null });
  });
});

describe("policy without a trust store", () => {
  it("falls back to W2: consequential calls ask, and prompts only when set to", () => {
    let settings = DEFAULT_SETTINGS;
    const gate = createPolicy({ settings: () => settings });
    const call = (name: string, input: unknown, tier: "reversible" | "consequential") =>
      gate({ name, input, tier, threadId: "t1", toolUseId: "u1" });
    const prompt = () => call("send_prompt", { text: "x" }, "reversible");
    expect(call("stop_session", {}, "consequential")).toBe("ask");
    expect(prompt()).toBe("run");
    settings = { ...settings, confirmPrompts: true };
    expect(prompt()).toBe("ask");
    expect(call("create_session", { project: "p" }, "reversible")).toBe("run");
    expect(call("create_session", { prompt: "fix it" }, "reversible")).toBe("ask");
    expect(call("open_panel", {}, "reversible")).toBe("run");
  });
});
