import { describe, expect, it } from "vitest";
import type { ProjectRef, WorkbenchPort } from "../port";
import { findProject } from "./read";

const p = (id: string, name: string, machine?: string): ProjectRef => ({
  id,
  name,
  rootPath: "/",
  group: null,
  remote: false,
  ...(machine && { machine }),
});

const port = (projects: ProjectRef[]) => ({ listProjects: () => projects }) as unknown as WorkbenchPort;

describe("a project on one of several machines (fleet plan F3.1)", () => {
  const fleet = port([p("d1", "workbench", "desktop"), p("l1", "workbench", "laptop"), p("l2", "notes@home", "laptop")]);

  it("takes name@machine, and a bare name on the machine Duck runs on", () => {
    expect(findProject(fleet, "workbench@laptop").id).toBe("l1");
    expect(findProject(fleet, "Workbench@Desktop").id).toBe("d1");
    expect(findProject(fleet, "workbench").id).toBe("d1");
    expect(findProject(fleet, "l1").id).toBe("l1");
  });

  it("still finds a name with an @ in it, and lists the machines when nothing matches", () => {
    expect(findProject(fleet, "notes@home").id).toBe("l2");
    expect(() => findProject(fleet, "workbench@server")).toThrow(/"workbench@laptop" \(l1\)/);
  });
});
