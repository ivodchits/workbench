import { describe, expect, it } from "vitest";

import type { RemoteChoice } from "../remote/protocol";
import { howLong, phaseText, tooltipLines, type Who } from "./describe";
import { ROSTER } from "./roster";
import { instance } from "./world/fixtures";

const felix = ROSTER.find((w) => w.id === "felix")!;

describe("how long", () => {
  it("counts seconds, minutes and hours", () => {
    expect(howLong(0)).toBe("0 s");
    expect(howLong(59_999)).toBe("59 s");
    expect(howLong(4 * 60_000 + 5000)).toBe("4 min");
    expect(howLong(2 * 3_600_000)).toBe("2 h");
    expect(howLong(2 * 3_600_000 + 5 * 60_000)).toBe("2 h 5 min");
    expect(howLong(-5)).toBe("0 s");
  });
});

describe("the phase in words", () => {
  it("says what a working session is doing", () => {
    expect(phaseText(instance("a", "p", { activity: "edit" }))).toBe("editing");
    expect(phaseText(instance("a", "p", { activity: "test" }))).toBe("running tests");
    expect(phaseText(instance("a", "p", { activity: null }))).toBe("working");
    expect(phaseText(instance("a", "p", { activity: "edit", subagents: 2 }))).toBe("editing, 2 subagents out");
    expect(phaseText(instance("a", "p", { activity: "edit", subagents: 1 }))).toBe("editing, 1 subagent out");
    expect(phaseText(instance("a", "p", { activity: "edit", compacting: true }))).toBe("compacting");
    expect(phaseText(instance("a", "p", { activity: "edit", stuck: true }))).toBe("stuck");
  });

  it("says what a waiting session asks", () => {
    const choice = (kind: RemoteChoice["kind"]): RemoteChoice => ({ id: "c", kind, toolName: "Bash", input: {}, questions: [], options: [], terminalOnly: null, sent: null });
    expect(phaseText(instance("a", "p", { phase: "needs_you" }))).toBe("needs you");
    expect(phaseText(instance("a", "p", { phase: "needs_you", choice: choice("permission") }))).toBe("needs you: wants permission");
    expect(phaseText(instance("a", "p", { phase: "needs_you", choice: choice("question") }))).toBe("needs you: has a question");
    expect(phaseText(instance("a", "p", { phase: "needs_you", escalated: true }))).toBe("really needs you");
  });

  it("counts a console with no status yet as idle", () => {
    expect(phaseText(instance("a", "p", { phase: null }))).toBe("idle");
    expect(phaseText(instance("a", "p", { phase: "done" }))).toBe("done");
    expect(phaseText(instance("a", "p", { phase: "ended" }))).toBe("session ended");
  });
});

describe("the tooltip", () => {
  it("names the worker, the session and how long it's been so", () => {
    const who: Who = { worker: felix, instance: instance("a", "p", { projectName: "Demiurge", title: "fix the build", activity: "read" }), since: 1000 };
    expect(tooltipLines(who, 1000 + 125_000)).toEqual(["Felix · Demiurge", "Demiurge · fix the build", "reading · 2 min"]);
  });

  it("says a worker with no session is free, and names a contractor", () => {
    expect(tooltipLines({ worker: felix, instance: null, since: null }, 0)).toEqual(["Felix · Demiurge", "free"]);
    const contractor = tooltipLines({ worker: null, instance: instance("b", "p", { projectName: "misc", title: "", taskNote: "" }), since: null }, 0);
    expect(contractor).toEqual(["Remote contractor", "misc · untitled", "working"]);
  });
});
