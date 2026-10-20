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
  killSession,
  resumeSession,
  sendPrompt,
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
    expect(queued.out.delivery).toMatch(/^queued: .*cancel/);
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

    const inherit = await run(createSession, { project: "Backend", model: "project" });
    expect(inherit.port.calls[0].args[0]).toMatchObject({ model: null });
    expect(inherit.out.model).toBe("the project's default");

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
