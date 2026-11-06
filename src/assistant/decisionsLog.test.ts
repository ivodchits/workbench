import { describe, expect, it, vi } from "vitest";

import type { DecisionRow } from "../ipc/assistant";
import { createDecisionsLog, entryLine, headerFor, sessionOfRow, stamp, trustEntry, type DecisionsLogBackend } from "./decisionsLog";

const AT = new Date(2026, 10, 6, 14, 5).getTime();

function memory() {
  const files = new Map<string, string>();
  const backend: DecisionsLogBackend = {
    append: async (id, header, text) => {
      await new Promise((r) => setTimeout(r, Math.random() * 5));
      files.set(id, `${files.get(id) ?? `${header}\n\n`}${text}\n`);
    },
    read: async (id) => files.get(id) ?? null,
    prune: async () => 0,
  };
  return { files, backend };
}

function row(r: Partial<Omit<DecisionRow, "id">>): Omit<DecisionRow, "id"> {
  return {
    ts: AT,
    threadId: "session:w",
    toolUseId: "t1",
    projectId: "p",
    tool: "Bash",
    summary: "workbench · Bash: npm test",
    input: {},
    decision: "allow",
    layer: "judge",
    reason: "the task runs the tests",
    ruleId: null,
    shadow: false,
    ...r,
  };
}

describe("the decisions log's lines", () => {
  it("says when, what kind, what was asked, what was decided and why, on one line", () => {
    expect(stamp(AT)).toBe("2026-11-06 14:05");
    expect(
      entryLine({ instanceId: "w", session: "workbench", kind: "question", step: "A2", asked: "Which\ndatabase?", decided: "SQLite", why: "The plan keeps it local." }, AT),
    ).toBe("- 2026-11-06 14:05 · question · [A2] Which database? → **SQLite** (The plan keeps it local)");
    expect(entryLine({ instanceId: "w", session: "workbench", kind: "permission", asked: "Bash: ls", decided: "allowed" }, AT)).toBe(
      "- 2026-11-06 14:05 · permission · Bash: ls → **allowed**",
    );
    expect(entryLine({ instanceId: "w", session: "s", kind: "question", asked: "x".repeat(1000), decided: "y" }, AT).length).toBeLessThan(470);
    expect(headerFor("workbench", "w")).toMatch(/^# Decisions on "workbench"\n\nSession w\./);
  });

  it("writes each session's lines in order, under its header, and says when it changed", async () => {
    const { files, backend } = memory();
    const changed = vi.fn();
    const log = createDecisionsLog({ backend, now: () => AT, changed });
    await Promise.all([
      log.heading("w", "workbench", "Autopilot started on plan.md"),
      log.record({ instanceId: "w", session: "workbench", kind: "question", asked: "one?", decided: "a" }),
      log.record({ instanceId: "w", session: "workbench", kind: "question", asked: "two?", decided: "b" }),
      log.record({ instanceId: "v", session: "voice", kind: "plan", asked: "approve its plan", decided: "approved" }),
    ]);
    const w = files.get("w")!;
    expect(w.startsWith('# Decisions on "workbench"')).toBe(true);
    expect(w.indexOf("## 2026-11-06 14:05 · Autopilot started on plan.md")).toBeLessThan(w.indexOf("one?"));
    expect(w.indexOf("one?")).toBeLessThan(w.indexOf("two?"));
    expect(files.get("v")).toContain("plan · approve its plan → **approved**");
    expect(changed.mock.calls.map((c) => c[0]).sort()).toEqual(["v", "w", "w", "w"]);
    expect(await log.read("w")).toBe(w);
  });

  it("drops a line it can't write, and keeps going", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let fail = true;
    const lines: string[] = [];
    const log = createDecisionsLog({
      backend: {
        append: async (_id, _h, text) => {
          if (fail) {
            fail = false;
            throw new Error("disk full");
          }
          lines.push(text);
        },
        read: async () => null,
        prune: async () => 0,
      },
    });
    await log.record({ instanceId: "w", session: "s", kind: "question", asked: "lost?", decided: "a" });
    await log.record({ instanceId: "w", session: "s", kind: "question", asked: "kept?", decided: "b" });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("kept?");
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe("trustEntry", () => {
  it("logs a permission prompt the trust layer approved or refused", () => {
    expect(trustEntry(row({}), "workbench")).toEqual({
      instanceId: "w",
      session: "workbench",
      kind: "permission",
      asked: "Bash: npm test",
      decided: "allowed",
      why: "the task runs the tests",
    });
    expect(trustEntry(row({ decision: "deny", layer: "rule" }), "workbench")).toMatchObject({ decided: "refused" });
  });

  it("logs a prompt it left to you, and T3's delegated answers and plans", () => {
    expect(trustEntry(row({ decision: "ask", reason: "a push" }), "workbench")).toMatchObject({ kind: "left to you", decided: "left to you", why: "a push" });
    expect(trustEntry(row({ layer: "delegated", summary: "workbench · asks: Which DB? → 1. SQLite", reason: "the task says local" }), "workbench")).toMatchObject({
      kind: "question",
      asked: "Which DB?",
      decided: "1. SQLite",
    });
    expect(trustEntry(row({ layer: "delegated", decision: "ask", summary: "workbench · asks: Delete it?" }), "workbench")).toMatchObject({
      kind: "left to you",
      asked: "Delete it?",
    });
    expect(trustEntry(row({ layer: "plan-review", summary: "workbench · its plan", reason: "does what was asked" }), "workbench")).toMatchObject({
      kind: "plan",
      decided: "approved (edits still ask)",
    });
    expect(trustEntry(row({ layer: "plan-review", decision: "ask" }), "workbench")).toMatchObject({ kind: "left to you", asked: "approve its plan" });
  });

  it("skips what was only logged, what closed first, and Duck's own tool calls", () => {
    expect(trustEntry(row({ shadow: true }), "workbench")).toBeNull();
    expect(trustEntry(row({ layer: "superseded" }), "workbench")).toBeNull();
    expect(trustEntry(row({ threadId: "thread-1" }), "workbench")).toBeNull();
    expect(sessionOfRow({ threadId: "session:abc" })).toBe("abc");
    expect(sessionOfRow({ threadId: "abc" })).toBeNull();
  });
});
