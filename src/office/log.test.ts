import { describe, expect, it } from "vitest";

import type { RemoteChoice, RemoteProject } from "../remote/protocol";
import { LOG_MAX, addToLog, logEvents } from "./log";
import { commitsToday, fullest, phaseCounts } from "./stats";
import { instance, snapshot } from "./world/fixtures";

const name = (id: string) => (id === "a" ? "Felix" : "Mira");
const texts = (prev: ReturnType<typeof snapshot> | null, next: ReturnType<typeof snapshot>) => logEvents(prev, next, name, 0).map((e) => e.text);
const project = (id: string, commitsToday: number | null): RemoteProject => ({ id, name: id, group: null, remote: false, lastCommitAt: null, commitsToday });

describe("the activity log", () => {
  it("says nothing about the first snapshot", () => {
    expect(texts(null, snapshot([instance("a", "dem")]))).toEqual([]);
  });

  it("tells sessions opening, working, waiting, finishing and closing", () => {
    const permission: RemoteChoice = { id: "c", kind: "permission", toolName: "Bash", input: {}, questions: [], options: [], terminalOnly: null, sent: null };
    const a = (over: Parameters<typeof instance>[2]) => instance("a", "dem", { projectName: "Demiurge", title: "fix the build", ...over });
    expect(texts(snapshot([a({ live: false, phase: null })]), snapshot([a({ phase: null })]))).toEqual(["Felix sat down to Demiurge · fix the build"]);
    expect(texts(snapshot([a({ phase: "done" })]), snapshot([a({ phase: "working" })]))).toEqual(["Felix got to work on fix the build"]);
    expect(texts(snapshot([a({})]), snapshot([a({ phase: "needs_you", choice: permission })]))).toEqual(["Felix needs you: wants permission"]);
    expect(texts(snapshot([a({})]), snapshot([a({ phase: "done" })]))).toEqual(["Felix finished fix the build"]);
    expect(texts(snapshot([a({})]), snapshot([a({ live: false })]))).toEqual(["Felix is done with Demiurge · fix the build: console closed"]);
    expect(texts(snapshot([a({})]), snapshot([a({ activity: "edit" })]))).toEqual([]);
  });

  it("counts new commits, not a new day's reset", () => {
    const at = (n: number | null) => ({ ...snapshot([]), projects: [project("web", n)] });
    expect(texts(at(2), at(3))).toEqual(["1 new commit in web"]);
    expect(texts(at(3), at(5))).toEqual(["2 new commits in web"]);
    expect(texts(at(null), at(4))).toEqual([]);
    expect(texts(at(5), at(0))).toEqual([]);
  });

  it("keeps the newest few, newest first", () => {
    const entry = (n: number) => ({ at: n, kind: "work" as const, text: String(n) });
    let log = addToLog([], [entry(1), entry(2)]);
    expect(log.map((e) => e.text)).toEqual(["2", "1"]);
    for (let n = 3; n < 20; n++) log = addToLog(log, [entry(n)]);
    expect(log).toHaveLength(LOG_MAX);
    expect(log[0].text).toBe("19");
  });
});

describe("the stats", () => {
  it("counts the live sessions by phase", () => {
    const counts = phaseCounts([
      instance("a", "p"),
      instance("b", "p", { phase: "needs_you" }),
      instance("c", "p", { phase: null }),
      instance("d", "p", { phase: "done" }),
      instance("e", "p", { phase: "ended" }),
      instance("f", "p", { live: false }),
    ]);
    expect(counts).toEqual({ working: 1, needs_you: 1, done: 1, idle: 1 });
  });

  it("lists the fullest contexts of live sessions", () => {
    const list = fullest([instance("a", "p", { ctxTokens: 50_000 }), instance("b", "p", { ctxTokens: 150_000 }), instance("c", "p", { ctxTokens: 0 }), instance("d", "p", { ctxTokens: 900_000, live: false })]);
    expect(list.map((i) => i.id)).toEqual(["b", "a"]);
  });

  it("adds up today's commits where they're known", () => {
    expect(commitsToday({ ...snapshot([]), projects: [project("a", 2), project("b", null), project("c", 3)] })).toBe(5);
    expect(commitsToday({ ...snapshot([]), projects: [project("a", null)] })).toBeNull();
  });
});
