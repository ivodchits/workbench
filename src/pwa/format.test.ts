import { describe, expect, it } from "vitest";

import type { RemoteInstance } from "../remote/protocol";
import { attentionLine, byAttention, countdown, glyphOf, metaLine, phaseOf, waitMins } from "./format";

function inst(over: Partial<RemoteInstance>): RemoteInstance {
  return {
    id: "i",
    projectId: "p",
    projectName: "proj",
    title: "one",
    taskNote: "",
    branch: null,
    worktreeOn: false,
    remote: false,
    phase: null,
    compacting: false,
    subagents: 0,
    status: "idle",
    ctxTokens: 0,
    live: true,
    needsSince: null,
    escalated: false,
    stuck: false,
    ...over,
  };
}

describe("phaseOf / glyphOf", () => {
  it("prefers the live phase to the persisted status", () => {
    expect(phaseOf(inst({ phase: "working", status: "done" }))).toBe("working");
    expect(phaseOf(inst({ phase: null, status: "done" }))).toBe("done");
  });

  it("draws a status it has no glyph for as idle", () => {
    expect(glyphOf(inst({ status: "closed" }))).toEqual(["▸", "idle"]);
    expect(glyphOf(inst({ phase: "needs_you" }))).toEqual(["●", "needs"]);
  });
});

describe("byAttention", () => {
  it("puts needs-you first, then working, and keeps ties in order", () => {
    const sorted = byAttention([
      inst({ id: "a", phase: "done" }),
      inst({ id: "b", phase: "working" }),
      inst({ id: "c", phase: "needs_you" }),
      inst({ id: "d", phase: "working" }),
      inst({ id: "e", status: "closed" }),
    ]);
    expect(sorted.map((i) => i.id)).toEqual(["c", "b", "d", "a", "e"]);
  });
});

describe("waitMins", () => {
  it("counts whole minutes, never below zero", () => {
    expect(waitMins(1000, 1000 + 125)).toBe(2);
    expect(waitMins(1000, 990)).toBe(0);
    expect(waitMins(null, 1000)).toBeNull();
  });
});

describe("countdown", () => {
  it("uses the two largest units", () => {
    expect(countdown(1000, 1000)).toBe("now");
    expect(countdown(1000 + 59 * 60, 1000)).toBe("in 59m");
    expect(countdown(1000 + 2 * 3600 + 13 * 60, 1000)).toBe("in 2h 13m");
    expect(countdown(1000 + 3 * 86400 + 4 * 3600 + 5 * 60, 1000)).toBe("in 3d 4h");
  });
});

describe("metaLine", () => {
  it("lists what applies", () => {
    expect(metaLine(inst({}))).toBe("proj");
    expect(
      metaLine(
        inst({
          branch: "main",
          ctxTokens: 41_600,
          remote: true,
          subagents: 2,
          compacting: true,
          live: false,
        }),
      ),
    ).toBe("proj · main · ctx 42k · ⇄ remote · 2 subagent(s) · compacting… · (not running)");
  });
});

describe("attentionLine", () => {
  it("is null when nobody waits", () => {
    expect(attentionLine([inst({ phase: "working" })])).toBeNull();
  });

  it("counts the waiting and the escalated among them", () => {
    expect(attentionLine([inst({ phase: "needs_you" })])).toBe("1 agent needs you");
    expect(
      attentionLine([
        inst({ phase: "needs_you", escalated: true }),
        inst({ phase: "needs_you" }),
        inst({ phase: "working", escalated: true }),
      ]),
    ).toBe("2 agents need you · 1 escalated");
  });
});
