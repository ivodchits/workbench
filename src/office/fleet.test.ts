import { describe, expect, it } from "vitest";

import type { RemoteInstance, RemoteProject, RemoteSnapshot } from "../remote/protocol";
import { mergeFleet, parsePeerId, peerId, toMachine, transcriptParams } from "./fleet";

function project(id: string, name: string, gitRemote: string | null = null): RemoteProject {
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
    phase: "working",
    compacting: false,
    subagents: 0,
    activity: null,
    status: "working",
    ctxTokens: 0,
    live: true,
    needsSince: null,
    escalated: false,
    stuck: false,
    choice: null,
  };
}
function snap(projects: RemoteProject[], instances: RemoteInstance[]): RemoteSnapshot {
  return { updatedAt: 0, usageLimits: null, instances, projects, duck: { state: "idle", autopilots: [] }, created: [] };
}

describe("the office on one floor", () => {
  const desktop = snap([project("wb", "workbench", "github.com/me/workbench")], [instance("a", "wb")]);
  const laptop = snap(
    [project("l-wb", "wb-laptop", "github.com/me/workbench"), project("solo", "solo"), project("empty", "empty")],
    [instance("a", "l-wb"), instance("b", "solo")],
  );

  it("is this machine's snapshot when there are no other machines", () => {
    expect(mergeFleet(desktop)).toEqual(desktop);
    expect(mergeFleet({ ...desktop, fleet: { here: "desktop", peers: [] } })).toEqual(desktop);
  });

  it("puts a matched project's sessions in its room, and a remote-only one in a room of its own", () => {
    const out = mergeFleet({ ...desktop, fleet: { here: "desktop", peers: [{ machine: "L", name: "laptop", snapshot: laptop }] } });
    expect(out.instances.map((i) => [i.id, i.projectId, i.machineName])).toEqual([
      ["a", "wb", "desktop"],
      ["m:L:a", "wb", "laptop"],
      ["m:L:b", "m:L:solo", "laptop"],
    ]);
    // The two machines' "a" never collide.
    expect(new Set(out.instances.map((i) => i.id)).size).toBe(3);
    expect(out.instances[1]).toMatchObject({ machine: "L", projectName: "workbench" });
    // A project with no sessions there isn't a room.
    expect(out.projects.map((p) => p.id)).toEqual(["wb", "m:L:solo"]);
  });

  it("sends another machine's actions and transcripts back with its own ids", () => {
    expect(parsePeerId(peerId("L", "x:y"))).toEqual({ machine: "L", id: "x:y" });
    expect(parsePeerId("plain")).toBeNull();
    expect(toMachine({ type: "approve", instanceId: "m:L:a" })).toEqual({ type: "approve", instanceId: "a", machine: "L" });
    expect(toMachine({ type: "approve", instanceId: "a" })).toEqual({ type: "approve", instanceId: "a" });
    expect(toMachine({ type: "create", requestId: "r", projectId: "m:L:solo" })).toEqual({ type: "create", requestId: "r", projectId: "solo", machine: "L" });
    expect(transcriptParams({ instance: "m:L:a", offset: "3" })).toEqual({ instance: "a", offset: "3", machine: "L" });
  });
});
