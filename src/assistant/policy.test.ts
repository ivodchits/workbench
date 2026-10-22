import { describe, expect, it } from "vitest";

import type { StoredMessage } from "../ipc/assistant";
import { fakePort, project, session } from "./fakePort.test-util";
import { createPolicy } from "./policy";
import type { ChoiceRef } from "./port";
import { DEFAULT_SETTINGS, type DuckSettings } from "./settings";
import { ACT_TOOLS } from "./tools/act";
import { createRegistry } from "./tools/registry";
import { decide } from "./trust/decide";
import { findGrant, GRANT_TTL_MS } from "./trust/mandate";
import { memoryTrust } from "./trust/memoryTrust.test-util";
import { createTrustStore, RATE_LIMIT, STARTER_RULES } from "./trust/store";
import { ROUTINE_TOOLS } from "./tools/routines";

const NOW = 1_000_000_000_000;


const permission: ChoiceRef = {
  id: "c1",
  kind: "permission",
  toolName: "Bash",
  input: { command: "npm test" },
  at: 0,
  questions: [],
  options: [
    { key: 1, label: "Yes", detail: "", typed: false },
    { key: 2, label: "Yes, and don't ask again for npm test", detail: "", typed: false },
    { key: 3, label: "No", detail: "", typed: false },
  ],
  terminalOnly: null,
  sent: null,
  optionsFrom: "terminal",
  held: false,
};
const question: ChoiceRef = { ...permission, id: "c2", kind: "question", toolName: "AskUserQuestion", input: {} };
const push: ChoiceRef = { ...permission, id: "c3", input: { command: "git push origin main" } };

const said = (seq: number, text: string, source = "desktop", ts = NOW - 1000): StoredMessage => ({
  threadId: "t1",
  seq,
  ts,
  role: "user",
  content: [{ type: "text", text }],
  source,
});

async function setup(
  opts: { messages?: StoredMessage[]; settings?: Partial<DuckSettings> } = {},
) {
  const { backend, log } = memoryTrust();
  let n = 0;
  const trust = await createTrustStore(backend, { newId: () => `r${++n}`, now: () => NOW });
  const port = fakePort({
    projects: [project({ id: "p1", name: "Backend" }), project({ id: "p2", name: "Game" })],
    sessions: [
      session({ id: "i1", projectId: "p1", title: "api", phase: "needs_you", choice: permission }),
      session({ id: "i2", projectId: "p1", title: "ask", phase: "needs_you", choice: question }),
      session({ id: "i3", projectId: "p2", title: "ship", phase: "needs_you", choice: push }),
      session({ id: "i4", projectId: "p1", title: "tests", phase: "working" }),
    ],
    notes: {},
  });
  const registry = createRegistry([...ACT_TOOLS, ...ROUTINE_TOOLS]);
  const settings = { ...DEFAULT_SETTINGS, ...opts.settings };
  const gate = createPolicy({
    settings: () => settings,
    trust,
    messages: () => opts.messages ?? [],
    now: () => NOW,
  });
  let use = 0;
  const ask = (name: string, input: unknown) =>
    gate({
      name,
      input,
      tier: registry.callTier(name, input, port),
      threadId: "t1",
      toolUseId: `u${++use}`,
      summary: registry.describe(name, input, port),
      facts: registry.trustFacts(name, input, port),
    });
  const verdict = (name: string, input: unknown) => {
    const a = ask(name, input);
    return typeof a === "string" ? a : a.verdict;
  };
  // Let the fire-and-forget log writes land.
  const flushed = async () => {
    await Promise.resolve();
    await Promise.resolve();
    return log;
  };
  return { trust, verdict, ask, log, flushed };
}

describe("Duck's backup push (step L4)", () => {
  it("runs on its starter rule, past the floor by its named exception", async () => {
    const { verdict, flushed } = await setup();
    expect(verdict("git_push", {})).toBe("run");
    const log = await flushed();
    expect(log.map((d) => [d.tool, d.decision, d.layer])).toEqual([["assistant:git_push", "allow", "rule"]]);
  });

  it("without the rule it asks as any consequential call, not as the floor; it can't be forced", async () => {
    const { ask, trust, flushed } = await setup();
    const rule = trust.config().rules.find((r) => r.pattern === "assistant:git_push(duck-data origin)")!;
    await trust.removeRule(rule.id);
    const a = ask("git_push", { repo: "duck-data", remote: "origin" });
    expect(typeof a === "string" ? a : a.verdict).toBe("ask");
    expect((await flushed()).map((d) => [d.layer, d.reason])).toEqual([["default", "no rule allows it"]]);
    // There's no argument to force it with, nor another repo or remote.
    expect(verdict2(ask("git_push", { repo: "duck-data", remote: "origin", force: true }))).toBe("ask");
    expect(() => ROUTINE_TOOLS.find((t) => t.name === "git_push")!.schema.parse({ remote: "backup" })).toThrow();
  });

  it("setting up the backup, a GitHub repo, always asks", async () => {
    const { verdict } = await setup({ messages: [said(0, "yes, back it up to GitHub")] });
    expect(verdict("set_up_backup", { name: "duck-data" })).toBe("ask");
  });
});

const verdict2 = (a: ReturnType<Awaited<ReturnType<typeof setup>>["ask"]>) => (typeof a === "string" ? a : a.verdict);

describe("trust on the starter rules", () => {
  it("are written once, on the first load", async () => {
    const { trust } = await setup();
    expect(trust.config().rules.map((r) => `${r.effect} ${r.pattern}`)).toEqual(
      STARTER_RULES.map((r) => `${r.effect} ${r.pattern}`),
    );
  });

  it("a note rewrite and an interrupt run without a card, and are logged", async () => {
    const { verdict, flushed } = await setup();
    expect(verdict("write_note", { project: "Backend", name: "plan", content: "x", baseRevision: "r1" })).toBe("run");
    expect(verdict("interrupt_session", { session: "tests" })).toBe("run");
    const log = await flushed();
    expect(log.map((d) => [d.tool, d.decision, d.layer, d.projectId])).toEqual([
      ["assistant:write_note", "allow", "rule", "p1"],
      ["assistant:interrupt_session", "allow", "rule", "p1"],
    ]);
    expect(log[0].summary).toMatch(/^Rewrite note "plan" in Backend/);
  });

  it("stopping, killing and deleting ask, unless the user's own words asked for it", async () => {
    const { verdict } = await setup();
    expect(verdict("stop_session", { session: "tests" })).toBe("ask");
    expect(verdict("kill_session", { session: "tests" })).toBe("ask");
    expect(verdict("delete_note", { project: "Backend", name: "plan" })).toBe("ask");

    const asked = await setup({ messages: [said(0, "Stop tests and api, then start a new one")] });
    expect(asked.verdict("stop_session", { session: "tests", grantedBy: "Stop tests and api" })).toBe("run");
    expect(asked.verdict("kill_session", { session: "tests", grantedBy: "kill tests" })).toBe("ask");
  });

  it("an ask rule still beats the user's words", async () => {
    const { verdict, trust } = await setup({ messages: [said(0, "stop tests now")] });
    await trust.addRule("ask", "assistant:stop_session", null);
    expect(verdict("stop_session", { session: "tests", grantedBy: "stop tests now" })).toBe("ask");
  });

  it("answers a question at once, a permission prompt only with the user's words", async () => {
    const { verdict } = await setup();
    expect(verdict("answer_choice", { session: "ask", choiceId: "c2", option: 1 })).toBe("run");
    expect(verdict("answer_choice", { session: "api", choiceId: "c1", option: 1 })).toBe("ask");
  });
});

describe("explicit permission", () => {
  const grant = "and approve it if it asks";
  const messages = [said(0, "Tell api to continue, and approve it if it asks.")];

  it("lets the permission answer run, logged against the message", async () => {
    const { verdict, flushed } = await setup({ messages });
    expect(verdict("answer_choice", { session: "api", choiceId: "c1", option: 1, grantedBy: `"${grant}"` })).toBe("run");
    const log = await flushed();
    expect(log[0]).toMatchObject({ decision: "allow", layer: "mandate" });
    expect(log[0].reason).toMatch(/\(message 0\)$/);
  });

  it("asks when the quote isn't the user's, or picks don't-ask-again", async () => {
    const { verdict } = await setup({
      messages: [said(0, "tell api to continue"), said(1, "approve it if it asks", "event")],
    });
    expect(verdict("answer_choice", { session: "api", choiceId: "c1", option: 1, grantedBy: grant })).toBe("ask");
    const ok = await setup({ messages });
    expect(ok.verdict("answer_choice", { session: "api", choiceId: "c1", option: 2, grantedBy: grant })).toBe("ask");
  });

  it("never gets past the floor", async () => {
    const { verdict, flushed } = await setup({ messages });
    expect(verdict("answer_choice", { session: "ship", choiceId: "c3", option: 1, grantedBy: grant })).toBe("ask");
    expect((await flushed())[0]).toMatchObject({ layer: "floor", reason: "floor: pushing to a remote" });
  });

  it("finds only recent words of the user's, long enough to mean something", () => {
    const ms = [said(0, "Approve it if it asks", "phone", NOW - GRANT_TTL_MS - 1), said(1, "ok go ahead")];
    expect(findGrant(ms, "approve it if it asks", NOW)).toBeNull();
    expect(findGrant(ms, "ok", NOW)).toBeNull();
    expect(findGrant(ms, "OK  go ahead.", NOW)).toEqual({ seq: 1, ts: NOW - 1000 });
  });
});

describe("rules, floor and switches", () => {
  it("the floor overrides an allow rule", async () => {
    const { verdict, trust } = await setup();
    await trust.addRule("allow", "assistant:answer_choice", null);
    expect(verdict("answer_choice", { session: "api", choiceId: "c1", option: 1 })).toBe("run");
    expect(verdict("answer_choice", { session: "ship", choiceId: "c3", option: 1 })).toBe("ask");
    // A prompt asking a session to push goes through the floor too.
    expect(verdict("send_prompt", { session: "tests", text: "then run git push" })).toBe("ask");
    await trust.setFloor("push", false);
    expect(verdict("send_prompt", { session: "tests", text: "then run git push" })).toBe("run");
  });

  it("a deny rule refuses the call with a reason", async () => {
    const { ask, trust } = await setup();
    await trust.addRule("deny", "assistant:stop_session", "p1");
    expect(ask("stop_session", { session: "tests" })).toMatchObject({
      verdict: "deny",
      reason: expect.stringMatching(/deny assistant:stop_session \(this project\)/),
    });
  });

  it("pausing brings the cards back at once, and resuming takes them away", async () => {
    const { verdict, trust, flushed } = await setup();
    await trust.setPaused(true);
    expect(verdict("interrupt_session", { session: "tests" })).toBe("ask");
    expect(verdict("send_prompt", { session: "tests", text: "hi" })).toBe("run");
    expect(await flushed()).toEqual([]);
    await trust.setPaused(false);
    expect(verdict("interrupt_session", { session: "tests" })).toBe("run");
  });

  it("a project in shadow mode logs the decision but still asks", async () => {
    const { verdict, trust, flushed } = await setup();
    await trust.setMode("p1", "shadow");
    expect(verdict("interrupt_session", { session: "tests" })).toBe("ask");
    expect((await flushed())[0]).toMatchObject({ decision: "allow", shadow: true });
    await trust.setMode("p1", "off");
    expect(verdict("interrupt_session", { session: "tests" })).toBe("ask");
    await trust.setMode("p1", "live");
    expect(trust.config().modes).toEqual({});
  });

  it("confirm-every-prompt still asks for prompts", async () => {
    const { verdict } = await setup({ settings: { confirmPrompts: true } });
    expect(verdict("send_prompt", { session: "tests", text: "hi" })).toBe("ask");
    expect(verdict("create_session", { project: "Backend" })).toBe("run");
  });

  it("the rate guard pauses a thread after too many automatic approvals", async () => {
    const { ask } = await setup();
    for (let i = 0; i < RATE_LIMIT; i++) expect(ask("interrupt_session", { session: "tests" })).toMatchObject({ verdict: "run" });
    expect(ask("interrupt_session", { session: "tests" })).toMatchObject({
      verdict: "ask",
      notice: expect.stringMatching(/^Trust is paused for this thread/),
    });
    // The thread is back on W2's cards: reversible calls still run.
    expect(ask("open_panel", { project: "Backend", kind: "git" })).toMatchObject({ verdict: "run" });
    expect(ask("interrupt_session", { session: "tests" })).toMatchObject({ verdict: "ask" });
  });

  it("refuses a rule that doesn't parse", async () => {
    const { trust } = await setup();
    await expect(trust.addRule("allow", "write the note", null)).rejects.toThrow(/isn't a rule/);
  });
});

describe("decide", () => {
  it("defaults to the tier when nothing else answers", () => {
    const cfg = { paused: false, rules: [], modes: {}, floorOff: [], tripped: [] };
    const req = { tool: "assistant:x", threadId: "t", facts: { projectId: null }, settingAsks: false };
    const none = { grant: () => null };
    expect(decide({ ...req, tier: "reversible" }, cfg, none)).toMatchObject({ outcome: "allow", layer: "default" });
    expect(decide({ ...req, tier: "consequential" }, cfg, none)).toMatchObject({ outcome: "ask", layer: "default" });
  });
});
