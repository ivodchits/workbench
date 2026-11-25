import { describe, expect, it } from "vitest";
import type { Instance } from "../../ipc/registry";
import type { MachineView } from "../../state/fleetView";
import type { RemoteInstance, RemoteSnapshot } from "../../remote/protocol";
import { pickKillTarget, pickRemoteKillTarget } from "./killTarget";

const inst = (id: string, projectId: string) => ({ id, projectId, title: id }) as Instance;
const instances = [inst("a1", "A"), inst("a2", "A"), inst("b1", "B"), inst("b2", "B")];

describe("pickKillTarget", () => {
  it("targets the focused console when it belongs to the selected project", () => {
    expect(pickKillTarget(instances, "A", "a2")).toEqual({ kind: "target", instance: instances[1] });
  });

  it("never targets a console from another project", () => {
    // Switched to A, but B's console is still the store's active one.
    const pick = pickKillTarget(instances, "A", "b1", "Alpha");
    expect(pick).toEqual({ kind: "none", reason: "no focused session in Alpha — nothing to kill" });
  });

  it("does nothing with no project selected, even with a focused console", () => {
    expect(pickKillTarget(instances, null, "a1").kind).toBe("none");
  });

  it("does nothing when no console is focused — no fallback to another session", () => {
    expect(pickKillTarget(instances, "A", null).kind).toBe("none");
  });

  it("does nothing when the selected project has no sessions", () => {
    expect(pickKillTarget(instances, "C", "b1").kind).toBe("none");
    expect(pickKillTarget([], "A", "a1").kind).toBe("none");
  });

  it("does nothing when the focused console's instance is gone", () => {
    expect(pickKillTarget(instances, "A", "zz").kind).toBe("none");
  });
});

describe("pickRemoteKillTarget", () => {
  const rinst = (id: string, remote = false) => ({ id, title: id, remote }) as RemoteInstance;
  const view = (machine: string, instances: RemoteInstance[] | null): MachineView => ({
    machine,
    snapshot: instances ? ({ instances } as RemoteSnapshot) : null,
    error: null,
    lastProjects: [],
  });
  const name = (m: string) => `name-${m}`;
  const views = new Map([
    ["m1", view("m1", [rinst("x"), rinst("ssh", true)])],
    ["m:2", view("m:2", [rinst("y:z")])],
    ["off", view("off", null)],
  ]);

  it("targets the session on its machine", () => {
    expect(pickRemoteKillTarget("m1:x", views, name)).toEqual({ kind: "target", machine: "m1", inst: rinst("x") });
  });

  it("matches machines and ids that contain colons", () => {
    expect(pickRemoteKillTarget("m:2:y:z", views, name)).toEqual({ kind: "target", machine: "m:2", inst: rinst("y:z") });
  });

  it("refuses an SSH project's session, a gone one, an offline machine and an unknown one", () => {
    expect(pickRemoteKillTarget("m1:ssh", views, name).kind).toBe("none");
    expect(pickRemoteKillTarget("m1:gone", views, name).kind).toBe("none");
    expect(pickRemoteKillTarget("off:x", views, name)).toEqual({ kind: "none", reason: "name-off is offline — can't kill its session" });
    expect(pickRemoteKillTarget("nope:x", views, name).kind).toBe("none");
  });
});
