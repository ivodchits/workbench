import { beforeEach, describe, expect, it, vi } from "vitest";

const sent: { machine: string; action: unknown }[] = [];
const flashes: string[] = [];
vi.mock("../ipc/fleet", () => ({
  fleetViewAction: (machine: string, action: unknown) => {
    sent.push({ machine, action });
    return Promise.resolve();
  },
}));
vi.mock("../util/flash", () => ({ flash: (m: string) => flashes.push(m) }));

import type { RemoteProject } from "../remote/protocol";
import { closeCreatePicker, getCreatePicker, newSessionElsewhere, targetsFor } from "./fleetCreate";
import { fleetRail } from "./fleetRail";

function project(id: string, name: string): RemoteProject {
  return { id, name, group: null, remote: false, lastCommitAt: null, commitsToday: null, gitRemote: null };
}
const snap = (projects: RemoteProject[]) => ({
  updatedAt: 0,
  usageLimits: null,
  instances: [],
  projects,
  duck: { state: "idle" as const, autopilots: [] },
  created: [],
});
const locals = [{ id: "wb", name: "workbench", gitRemote: null }];

describe("a new session on the other machine", () => {
  beforeEach(() => {
    sent.length = 0;
    flashes.length = 0;
    closeCreatePicker();
  });

  it("goes straight to the one other machine with the project, as its own project id", async () => {
    const rail = fleetRail(locals, [{ machine: "L", name: "laptop", snapshot: snap([project("l-wb", "workbench")]) }]);
    expect(targetsFor(rail, "wb")).toEqual([{ machine: "L", name: "laptop", online: true, projectId: "l-wb" }]);
    newSessionElsewhere(rail, "wb", "workbench");
    await Promise.resolve();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ machine: "L", action: { type: "create", projectId: "l-wb" } });
  });

  it("says so, and sends nothing, when the machine is offline or doesn't have it", () => {
    const offline = fleetRail(locals, [{ machine: "L", name: "laptop", snapshot: null, lastProjects: [project("l-wb", "workbench")] }]);
    newSessionElsewhere(offline, "wb", "workbench");
    const missing = fleetRail(locals, [{ machine: "L", name: "laptop", snapshot: snap([project("x", "other")]) }]);
    newSessionElsewhere(missing, "wb", "workbench");
    newSessionElsewhere(fleetRail(locals, []), "wb", "workbench");
    expect(sent).toHaveLength(0);
    expect(flashes).toEqual(["laptop is offline.", "workbench isn't on the other machine.", "There's no other machine in the fleet."]);
  });

  it("asks which, with more than one", () => {
    const rail = fleetRail(locals, [
      { machine: "L", name: "laptop", snapshot: snap([project("l-wb", "workbench")]) },
      { machine: "S", name: "server", snapshot: null, lastProjects: [project("s-wb", "workbench")] },
    ]);
    newSessionElsewhere(rail, "wb", "workbench");
    expect(sent).toHaveLength(0);
    expect(flashes).toHaveLength(0);
    expect(getCreatePicker()?.targets.map((t) => [t.name, t.online])).toEqual([["laptop", true], ["server", false]]);
  });
});
