import { describe, expect, it } from "vitest";

import { fakePort, project, session, toolCtx, type FakePortData } from "../fakePort.test-util";
import type { ChoiceRef } from "../port";
import { decide, type TrustConfig } from "../trust/decide";
import { createRegistry } from "./registry";
import { KEY_GAP_MS, pressKeys, readScreen, SCREEN_TOOLS, screenHash } from "./screen";

const choice: ChoiceRef = {
  id: "c7",
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
};

const UNSENT = ["╭────╮", "│ ❯ fix the login test │", "╰────╯", "", ""];

function data(): FakePortData {
  return {
    projects: [project({ id: "p1", name: "Backend" })],
    sessions: [
      session({ id: "i1", projectId: "p1", title: "api", phase: "idle" }),
      session({ id: "i2", projectId: "p1", title: "tests", phase: "needs_you", choice }),
      session({ id: "i3", projectId: "p1", title: "torn", phase: "idle" }),
    ],
    screens: { i1: [...UNSENT], i2: ["Bash command", "npm test", "❯ 1. Yes", "  2. Yes, and don't ask again", "  3. No"] },
  };
}

const registry = createRegistry(SCREEN_TOOLS);
const cfg = (rules: TrustConfig["rules"] = []): TrustConfig => ({
  paused: false,
  rules,
  modes: {},
  floorOff: [],
  tripped: [],
});
const grantAll = { grant: () => ({ seq: 1 }) };

function decision(port: ReturnType<typeof fakePort>, input: Record<string, unknown>, c = cfg()) {
  return decide(
    {
      tool: "assistant:press_keys",
      tier: "consequential",
      threadId: "t",
      facts: registry.trustFacts("press_keys", input, port),
      settingAsks: false,
    },
    c,
    grantAll,
  );
}

describe("read_screen", () => {
  it("returns the screen wrapped as untrusted, with its hash", async () => {
    const port = fakePort(data());
    const out = (await readScreen.run({ session: "api" }, toolCtx(port))) as string;
    expect(out).toContain(`hash="${screenHash(UNSENT)}" untrusted>`);
    expect(out).toContain("❯ fix the login test");
    expect(out.trimEnd().endsWith("╰────╯\n</screen>")).toBe(true);
  });

  it("says so when this window has no terminal for the session", async () => {
    const port = fakePort(data());
    await expect(Promise.resolve().then(() => readScreen.run({ session: "torn" }, toolCtx(port)))).rejects.toThrow(
      /No terminal for "torn"/,
    );
  });
});

describe("screenHash", () => {
  it("holds still while a turn's counters and spinner move", () => {
    const a = ["✻ Thinking… (3s · ↓ 120 tokens)", "❯ "];
    const b = ["✶ Thinking… (14s · ↓ 2041 tokens)", "❯ "];
    expect(screenHash(a)).toBe(screenHash(b));
    expect(screenHash(a)).not.toBe(screenHash(["✻ Thinking… (3s)", "❯ x"]));
  });
});

/** A press_keys context, as after its `prepare`. */
const keysCtx = (port: ReturnType<typeof fakePort>) => ({ ...toolCtx(port), prepared: { tail: [] } });

describe("press_keys", () => {
  it("presses Enter on a prompt sitting unsent, and leaves a chip", async () => {
    const d = data();
    d.onKeys = (id) => (d.screens![id] = ["╭────╮", "│ ❯ │", "╰────╯"]);
    const port = fakePort(d);
    const ctx = keysCtx(port);
    const out = await pressKeys.run({ session: "api", keys: ["enter"], screenHash: screenHash(UNSENT) }, ctx);
    expect(port.calls).toContainEqual({ name: "pressKeys", args: ["i1", ["\r"], KEY_GAP_MS] });
    expect(ctx.notices).toEqual([{ kind: "keys", text: "Duck pressed Enter in api" }]);
    expect(out).toContain("│ ❯ │");
  });

  it("sends nothing on a stale screen", async () => {
    const port = fakePort(data());
    await expect(
      pressKeys.run({ session: "api", keys: ["enter"], screenHash: "deadbeef" }, keysCtx(port)),
    ).rejects.toThrow(/^stale:.*nothing was sent/);
    expect(port.calls.some((c) => c.name === "pressKeys")).toBe(false);
  });

  it("writes named keys and text as their bytes", async () => {
    const port = fakePort(data());
    await pressKeys.run(
      { session: "api", keys: ["ctrl+u", { text: "hi" }, "shift+tab", "escape"], screenHash: screenHash(UNSENT) },
      keysCtx(port),
    );
    expect(port.calls.find((c) => c.name === "pressKeys")?.args[1]).toEqual(["\x15", "hi", "\x1b[Z", "\x1b"]);
  });

  it("refuses control characters in text", () => {
    const bad = pressKeys.schema.safeParse({ session: "api", keys: [{ text: "go\r" }], screenHash: "x" });
    expect(bad.success).toBe(false);
  });

  it("is an ordinary consequential call away from a prompt", () => {
    const port = fakePort(data());
    expect(decision(port, { session: "api", keys: ["enter"], screenHash: "x" })).toMatchObject({ outcome: "ask", layer: "default" });
    expect(
      decision(port, { session: "api", keys: ["enter"], screenHash: "x", grantedBy: "press enter in api" }),
    ).toMatchObject({ outcome: "allow", layer: "mandate" });
    // The floor reads typed text.
    expect(
      decision(port, { session: "api", keys: [{ text: "rm -rf /" }], screenHash: "x", grantedBy: "type it" }),
    ).toMatchObject({ outcome: "ask", layer: "floor" });
  });

  it("is judged as answer_choice inside an open prompt", () => {
    const port = fakePort(data());
    const rule = { id: "r1", effect: "deny" as const, pattern: "assistant:answer_choice(permission)", projectId: null, created: 0 };
    expect(decision(port, { session: "tests", keys: ["1"], screenHash: "x" }, cfg([rule]))).toMatchObject({
      outcome: "deny",
      layer: "rule",
    });
    const facts = registry.trustFacts("press_keys", { session: "tests", keys: ["1"], screenHash: "x" }, port);
    expect(facts).toMatchObject({ specifier: "permission", call: { tool: "Bash", input: { command: "npm test" } } });
    // Backing out lets nothing through.
    expect(registry.trustFacts("press_keys", { session: "tests", keys: ["escape"], screenHash: "x" }, port).call).toBeUndefined();
  });

  it("never takes a quote for a \"don't ask again\" or a move it can't see", () => {
    const port = fakePort(data());
    const quoted = (keys: unknown[]) =>
      decision(port, { session: "tests", keys, screenHash: "x", grantedBy: "approve it" }).outcome;
    expect(quoted(["1"])).toBe("allow");
    expect(quoted(["2"])).toBe("ask");
    expect(quoted(["down", "enter"])).toBe("ask");
  });
});
