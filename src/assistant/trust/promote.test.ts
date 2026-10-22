import { describe, expect, it } from "vitest";

import type { DecisionRow } from "../../ipc/assistant";
import { project } from "../fakePort.test-util";
import type { TrustConfig } from "./decide";
import { memoryTrust } from "./memoryTrust.test-util";
import { createPromoter, lineDiff, promotionKey, promotions, withAllow } from "./promote";
import { createTrustStore } from "./store";

let id = 0;
function row(over: Partial<DecisionRow> = {}): DecisionRow {
  return {
    id: ++id,
    ts: id,
    threadId: "session:s1",
    toolUseId: `c${id}`,
    projectId: "p1",
    tool: "Bash",
    summary: "api · Bash: npm test -- auth",
    input: { command: "npm test -- auth" },
    decision: "allow",
    layer: "judge",
    reason: "runs the tests",
    ruleId: null,
    shadow: false,
    ...over,
  };
}

const cfg = (rules: TrustConfig["rules"] = []): TrustConfig => ({ paused: false, rules, modes: {}, floorOff: [], tripped: [] });

describe("promotions (T3)", () => {
  it("offers a pattern approved three times in a project, shadow ones counted", () => {
    const rows = [row(), row({ input: { command: "npm test -- db" } }), row({ shadow: true, layer: "rule" })];
    expect(promotions(rows.slice(0, 2), cfg(), [])).toEqual([]);
    expect(promotions(rows, cfg(), [])).toEqual([
      expect.objectContaining({ key: promotionKey("p1", "Bash(npm test:*)"), pattern: "Bash(npm test:*)", count: 3, shadow: 1, ruled: false }),
    ]);
  });

  it("counts only approvals of session prompts, per project, and not settled ones", () => {
    const rows = [
      row(),
      row(),
      row({ projectId: "p2" }),
      row({ decision: "ask" }),
      row({ layer: "superseded" }),
      row({ threadId: "t1", tool: "assistant:send_prompt" }),
      row({ tool: "AskUserQuestion", layer: "delegated" }),
    ];
    expect(promotions(rows, cfg(), [])).toEqual([]);
    const three = [row(), row(), row()];
    expect(promotions(three, cfg(), [promotionKey("p1", "Bash(npm test:*)")])).toEqual([]);
  });

  it("never offers a bare tool, and marks one a Duck rule covers", () => {
    const bare = [1, 2, 3].map(() => row({ input: { command: "./build.sh" } }));
    expect(promotions(bare, cfg(), [])).toEqual([]);
    const rule = { id: "r", effect: "allow" as const, pattern: "Bash(npm test:*)", projectId: null, created: 0 };
    expect(promotions([row(), row(), row()], cfg([rule]), [])[0].ruled).toBe(true);
  });
});

describe("withAllow", () => {
  it("makes a new file, adds to an existing list and keeps everything else", () => {
    expect(withAllow(null, "Bash(npm test:*)")).toEqual({
      text: '{\n  "permissions": {\n    "allow": [\n      "Bash(npm test:*)"\n    ]\n  }\n}\n',
      already: false,
    });
    const text = '{\n    "env": { "A": "1" },\n    "permissions": { "allow": ["Read"], "deny": ["Bash(rm:*)"] }\n}\n';
    const next = JSON.parse(withAllow(text, "Bash(npm test:*)").text);
    expect(next).toEqual({ env: { A: "1" }, permissions: { allow: ["Read", "Bash(npm test:*)"], deny: ["Bash(rm:*)"] } });
    // Its indent is kept.
    expect(withAllow(text, "Bash(npm test:*)").text).toContain('\n    "env"');
  });

  it("says when it's there already, and refuses what Claude Code wouldn't read", () => {
    const text = '{"permissions":{"allow":["Bash(npm test:*)"]}}';
    expect(withAllow(text, "Bash(npm test:*)")).toEqual({ text, already: true });
    expect(() => withAllow("{ not json", "X(y)")).toThrow(/valid JSON/);
    expect(() => withAllow("[]", "X(y)")).toThrow(/object/);
    expect(() => withAllow('{"permissions":{"allow":"Read"}}', "X(y)")).toThrow(/list/);
  });

  it("diffs the preview line by line", () => {
    expect(lineDiff("a\nb\nc\n", "a\nb2\nc\n")).toEqual([
      { op: " ", text: "a" },
      { op: "-", text: "b" },
      { op: "+", text: "b2" },
      { op: " ", text: "c" },
    ]);
    expect(lineDiff("", "x\n")).toEqual([{ op: "+", text: "x" }]);
  });
});

describe("the promoter", () => {
  async function setup(rows: DecisionRow[], before: string | null) {
    const { backend, log } = memoryTrust();
    log.push(...rows);
    const trust = await createTrustStore(backend, { now: () => 1 });
    let settled: string[] = [];
    const files: Record<string, string | null> = { "C:/src/app": before };
    const writes: { root: string; text: string; expected: string | null }[] = [];
    const p = createPromoter({
      trust,
      projects: () => [project({ id: "p1", name: "app", rootPath: "C:/src/app" })],
      settled: () => settled,
      settle: async (keys) => void (settled = keys),
      readSettings: async (root) => files[root] ?? null,
      async writeSettings(root, text, expected) {
        if ((files[root] ?? null) !== expected) throw new Error("stale: changed since it was read");
        writes.push({ root, text, expected });
        files[root] = text;
      },
    });
    await new Promise((r) => setTimeout(r, 0));
    return { p, trust, writes, files, settled: () => settled };
  }

  it("previews the file and writes it over what it showed, then stops offering", async () => {
    const t = await setup([row(), row(), row()], null);
    const [offer] = t.p.list();
    const preview = await t.p.preview(offer.key);
    expect(preview).toMatchObject({ before: null, already: false, path: "C:/src/app/.claude/settings.local.json" });
    expect(await t.p.promote(offer.key, "claude", preview.before)).toBe("Bash(npm test:*) is on app's Claude Code allow list");
    expect(t.writes).toEqual([{ root: "C:/src/app", text: preview.after, expected: null }]);
    expect(t.p.list()).toEqual([]);
  });

  it("refuses to write over a file changed since the preview", async () => {
    const t = await setup([row(), row(), row()], "{}");
    const [offer] = t.p.list();
    const preview = await t.p.preview(offer.key);
    t.files["C:/src/app"] = '{"model":"opus"}';
    await expect(t.p.promote(offer.key, "claude", preview.before)).rejects.toThrow(/stale/);
    expect(t.p.list()).toHaveLength(1);
  });

  it("makes it a Duck rule for the project, or dismisses it", async () => {
    const t = await setup([row(), row(), row()], null);
    const [offer] = t.p.list();
    await t.p.promote(offer.key, "rule");
    expect(t.trust.config().rules.filter((r) => r.pattern === "Bash(npm test:*)")).toEqual([
      expect.objectContaining({ effect: "allow", projectId: "p1" }),
    ]);
    expect(t.settled()).toEqual([offer.key]);
    const u = await setup([row(), row(), row()], null);
    await u.p.dismiss(u.p.list()[0].key);
    expect(u.p.list()).toEqual([]);
  });

  it("counts new decisions as they're logged", async () => {
    const t = await setup([row(), row()], null);
    expect(t.p.list()).toEqual([]);
    let heard = 0;
    t.p.subscribe(() => heard++);
    await t.trust.log(row());
    expect(t.p.list()).toHaveLength(1);
    expect(heard).toBe(1);
  });
});
