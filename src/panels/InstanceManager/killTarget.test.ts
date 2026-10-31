import { describe, expect, it } from "vitest";
import type { Instance } from "../../ipc/registry";
import { pickKillTarget } from "./killTarget";

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
