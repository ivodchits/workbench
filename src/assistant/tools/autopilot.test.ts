import { describe, expect, it } from "vitest";

import { createAutopilot } from "../autopilot";
import { fakePort, project, session, toolCtx } from "../fakePort.test-util";
import { autopilotStatus, minutesOf, planPathFor, showAutopilotDecisions, startAutopilot, stopAutopilot, windowOf } from "./autopilot";

describe("autopilot tools", () => {
  it("resolves a plan path against the session's folder", () => {
    expect(planPathFor("documentation/plan.md", "C:\\repos\\wb")).toBe("C:\\repos\\wb\\documentation\\plan.md");
    expect(planPathFor("./docs/plan.md", "/home/me/wb/")).toBe("/home/me/wb/docs/plan.md");
    expect(planPathFor("D:/plans/p.md", "C:\\repos\\wb")).toBe("D:/plans/p.md");
  });

  it("reads times and daily windows", () => {
    expect(minutesOf("7:30")).toBe(450);
    expect(windowOf("22:00-07:00")).toEqual({ from: 1320, to: 420 });
    expect(windowOf("09:00 to 18:00")).toEqual({ from: 540, to: 1080 });
    expect(() => minutesOf("25:00")).toThrow("isn't a time");
    expect(() => windowOf("22:00")).toThrow("isn't a window");
    expect(() => windowOf("8:00-08:00")).toThrow("the same time");
  });

  it("starts a run in this thread, shows it, and stops it", async () => {
    const port = fakePort({
      projects: [project({ id: "p" })],
      sessions: [session({ id: "w", projectId: "p", title: "workbench", phase: "working", workingDir: "C:\\repos\\wb" })],
    });
    const read: string[] = [];
    const autopilot = createAutopilot({
      port,
      backend: { put: async () => {}, list: async () => [], remove: async () => {} },
      call: () => Promise.reject(new Error("not called")),
      readFile: async (p) => {
        read.push(p);
        return "# Plan";
      },
      tell: () => {},
      notice: () => {},
    });
    const ctx = { ...toolCtx(port), threadId: "t9", autopilot };
    const started = await startAutopilot.run(
      { session: "workbench", plan: "documentation/plan.md", max_steps: 3, fixed_prompts: true },
      ctx,
    );
    expect(read).toEqual(["C:\\repos\\wb\\documentation\\plan.md"]);
    expect(started).toMatchObject({ state: "running", steps: "0 done of at most 3", prompts: "continue the implementation / proceed to the next step" });
    expect(autopilot.get("w")?.threadId).toBe("t9");

    const status = await autopilotStatus.run({}, ctx);
    expect((status as { autopilots: unknown[] }).autopilots).toHaveLength(1);
    expect(await stopAutopilot.run({ session: "w" }, ctx)).toMatchObject({ state: "stopped", why: "stopped by the user" });

    // Until done, in a window that's open around the clock but for a minute, with the
    // user's own checklist.
    const now = new Date();
    const m = now.getHours() * 60 + now.getMinutes();
    const clock = (x: number) => `${Math.floor(x / 60)}:${String(x % 60).padStart(2, "0")}`;
    const bounded = await startAutopilot.run(
      { session: "w", plan: "documentation/plan.md", until_done: true, window: `${clock(m)}-${clock((m + 1439) % 1440)}`, checklist: ["the demo runs"] },
      ctx,
    );
    expect(bounded).toMatchObject({ state: "running", steps: "0 done, until the plan is done", checklist: ["the demo runs"] });
    autopilot.dispose();
  });
});

describe("show_autopilot_decisions", () => {
  const LOG = [
    '# Decisions on "workbench"',
    "",
    "Session w.",
    "",
    "## 2026-11-06 14:00 · Autopilot started on plan.md",
    "",
    "- 2026-11-06 14:05 · question · Which DB? → **SQLite** (local)",
    "",
  ].join("\n");

  function setup(sessions = [session({ id: "w", projectId: "p", title: "workbench", phase: "working" })]) {
    const port = fakePort({ projects: [project({ id: "p" })], sessions });
    const autopilot = createAutopilot({
      port,
      backend: { put: async () => {}, list: async () => [], remove: async () => {} },
      call: () => Promise.reject(new Error("not called")),
      readFile: async () => "# Plan",
      tell: () => {},
      notice: () => {},
    });
    const files: Record<string, string> = { w: LOG };
    const decisions = { record: async () => {}, heading: async () => {}, read: async (id: string) => files[id] ?? null, prune: async () => 0 };
    return { port, autopilot, ctx: { ...toolCtx(port), autopilot, decisions } };
  }

  it("opens the session's log for the user and returns its lines", async () => {
    const { port, ctx } = setup();
    const out = await showAutopilotDecisions.run({ session: "workbench" }, ctx);
    expect(out).toEqual({
      session: "workbench",
      opened: true,
      entries: ["## 2026-11-06 14:00 · Autopilot started on plan.md", "- 2026-11-06 14:05 · question · Which DB? → **SQLite** (local)"],
    });
    expect(port.calls.filter((c) => c.name === "openDecisionsLog").map((c) => c.args)).toEqual([["w"]]);
    // Read only.
    await showAutopilotDecisions.run({ session: "workbench", open: false }, ctx);
    expect(port.calls.filter((c) => c.name === "openDecisionsLog")).toHaveLength(1);
  });

  it("finds the session on autopilot when none is named, and says when there's nothing", async () => {
    const { autopilot, ctx } = setup([
      session({ id: "w", projectId: "p", title: "workbench", phase: "working" }),
      session({ id: "v", projectId: "p", title: "voice", phase: "working" }),
    ]);
    await expect(showAutopilotDecisions.run({}, ctx)).rejects.toThrow("No session has been on autopilot");
    await autopilot.start({ instanceId: "v", threadId: "t", planPath: "plan.md" });
    expect(await showAutopilotDecisions.run({ open: false }, ctx)).toEqual({ session: "voice", entries: "nothing logged for this session yet" });
    await autopilot.start({ instanceId: "w", threadId: "t", planPath: "plan.md" });
    await expect(showAutopilotDecisions.run({}, ctx)).rejects.toThrow('2 sessions are on autopilot: name one ("workbench", "voice")');
  });
});
