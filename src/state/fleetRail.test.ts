import { describe, expect, it } from "vitest";

import type { RemoteInstance, RemoteProject, RemoteSnapshot } from "../remote/protocol";
import { fleetRail, type LocalProjectRef } from "./fleetRail";

function project(id: string, name: string, gitRemote: string | null): RemoteProject {
  return { id, name, group: null, remote: false, lastCommitAt: null, commitsToday: null, gitRemote };
}

function instance(id: string, projectId: string): RemoteInstance {
  return {
    id,
    projectId,
    projectName: "",
    title: id,
    taskNote: "",
    branch: null,
    worktreeOn: false,
    remote: false,
    phase: null,
    compacting: false,
    subagents: 0,
    activity: null,
    status: "idle",
    ctxTokens: 0,
    live: false,
    needsSince: null,
    escalated: false,
    stuck: false,
    choice: null,
  } as RemoteInstance;
}

function snap(projects: RemoteProject[], instances: RemoteInstance[]): RemoteSnapshot {
  return { updatedAt: 0, usageLimits: null, instances, projects, duck: { state: "idle", autopilots: [] }, created: [] };
}

const locals: LocalProjectRef[] = [
  { id: "wb", name: "workbench", gitRemote: "github.com/me/workbench" },
  { id: "notes", name: "notes", gitRemote: null },
  { id: "game", name: "game", gitRemote: "github.com/me/game" },
];

describe("fleetRail", () => {
  const laptop = snap(
    [
      // The same repo under another folder name.
      project("l-wb", "workbench-laptop", "github.com/me/workbench"),
      // No remote on either side: by name.
      project("l-notes", "Notes", null),
      // The same name, another remote: kept apart.
      project("l-game", "game", "github.com/someone/game"),
      // Only there, with a session, and without.
      project("l-solo", "solo", null),
      project("l-empty", "empty", null),
    ],
    [instance("a", "l-wb"), instance("b", "l-wb"), instance("c", "l-notes"), instance("d", "l-game"), instance("e", "l-solo")],
  );

  it("groups the sessions by machine under the matched projects (decisions 1–4)", () => {
    const rail = fleetRail(locals, [{ machine: "L", name: "laptop", snapshot: laptop }]);
    expect(rail.merged.get("wb")).toEqual([
      { machine: "L", machineName: "laptop", projectId: "l-wb", instances: [instance("a", "l-wb"), instance("b", "l-wb")] },
    ]);
    expect(rail.merged.get("notes")?.[0].instances.map((i) => i.id)).toEqual(["c"]);
    expect(rail.merged.has("game")).toBe(false);
    const [section] = rail.sections;
    expect(section.online).toBe(true);
    expect(section.withSessions.map((r) => r.project.id)).toEqual(["l-game", "l-solo"]);
    expect(section.noSessions.map((r) => r.project.id)).toEqual(["l-empty"]);
  });

  it("matches by name while a remote is still being looked up", () => {
    const rail = fleetRail([{ id: "wb", name: "workbench" }], [
      { machine: "L", name: "laptop", snapshot: snap([project("x", "workbench", "github.com/me/workbench")], []) },
    ]);
    expect(rail.merged.get("wb")?.[0].projectId).toBe("x");
  });

  it("keeps an offline machine's divider in the projects it had, with no sessions", () => {
    const rail = fleetRail(locals, [{ machine: "L", name: "laptop", snapshot: null, lastProjects: laptop.projects }]);
    expect(rail.merged.get("wb")).toEqual([{ machine: "L", machineName: "laptop", projectId: "l-wb", instances: [] }]);
    expect(rail.sections).toEqual([{ machine: "L", name: "laptop", online: false, withSessions: [], noSessions: [] }]);
  });

  it("puts each machine in its own section, and several of its projects in one entry", () => {
    const rail = fleetRail(locals, [
      { machine: "L", name: "laptop", snapshot: snap([project("p1", "workbench", null), project("p2", "wb2", "github.com/me/workbench")], [instance("x", "p1"), instance("y", "p2")]) },
      { machine: "S", name: "server", snapshot: snap([project("s1", "workbench", "github.com/me/workbench")], [instance("z", "s1")]) },
    ]);
    const wb = rail.merged.get("wb")!;
    expect(wb.map((m) => m.machine)).toEqual(["L", "S"]);
    expect(wb[0].instances.map((i) => i.id)).toEqual(["x", "y"]);
    expect(rail.sections.map((s) => s.name)).toEqual(["laptop", "server"]);
  });
});
