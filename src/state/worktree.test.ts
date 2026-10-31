import { beforeEach, describe, expect, it, vi } from "vitest";

import type { WorktreeEntry } from "../ipc/git";
import type { Instance, InstancePatch, Project } from "../ipc/registry";

let instances: Instance[] = [];
let consoles: { instanceId: string; status: string }[] = [];
let worktrees: WorktreeEntry[] = [];
let conversations: Record<string, string[]> = {};
const calls: string[] = [];

vi.mock("../ipc/git", () => ({
  listWorktrees: async () => worktrees,
  resolveWorktree: async (_root: string, target: string) => {
    const w = worktrees.find((x) => !x.isMain && (x.path === target || x.branch === target));
    if (!w) throw new Error(`${target} isn't a worktree of /root`);
    return w;
  },
  integrateWorktree: vi.fn(),
  removeWorktree: async () => calls.push("remove"),
  provisionWorktree: vi.fn(),
  runWorktreeSetup: vi.fn(),
}));
vi.mock("../ipc/sessions", () => ({
  listProjectSessions: async (dir: string) => (conversations[dir] ?? []).map((sessionId) => ({ sessionId })),
}));
vi.mock("../ipc/prefs", () => ({ getPref: async (_k: string, d: unknown) => d }));
vi.mock("./consoles", () => ({
  getOpenConsoles: () => consoles,
  closeConsole: (id: string) => calls.push(`close ${id}`),
  openConsole: (i: Instance) => calls.push(`open ${i.id} ${i.workingDir}`),
  resumeConsole: (i: Instance, sid: string) => calls.push(`resume ${i.id} ${i.workingDir} ${sid}`),
}));
vi.mock("../panels/terminalPool", () => ({ release: vi.fn() }));
vi.mock("./registry", () => ({
  getRegistry: () => ({ instances }),
  updateInstance: async (id: string, patch: InstancePatch) => {
    instances = instances.map((i) => (i.id === id ? ({ ...i, ...patch } as Instance) : i));
  },
}));

import { attachWorktree, projectWorktrees, sessionsInDir, teardownWorktree } from "./worktree";

const project = { id: "p1", name: "demiurge", rootPath: "C:\\r\\demiurge", remoteSshDest: null } as Project;
const wt2 = "C:\\r\\.workbench\\worktrees\\2";

function inst(id: string, workingDir: string, more: Partial<Instance> = {}): Instance {
  return {
    id,
    projectId: "p1",
    title: id,
    workingDir,
    worktreeOn: false,
    worktreeOwned: true,
    branch: null,
    lastSessionId: "s-root",
    ...more,
  } as Instance;
}

const entry = (path: string, branch: string | null, isMain = false): WorktreeEntry => ({
  path,
  branch,
  head: "abc1234",
  subject: "work",
  committedAt: 1,
  isMain,
  locked: false,
  missing: false,
});

beforeEach(() => {
  calls.length = 0;
  consoles = [];
  conversations = { [wt2]: ["s-newest", "s-older"] };
  worktrees = [entry(project.rootPath, "main", true), entry(wt2, "agent/2")];
  instances = [inst("a", project.rootPath)];
});

describe("attachWorktree", () => {
  it("points the session at the worktree, not as its own, on its newest conversation there", async () => {
    const r = await attachWorktree(instances[0], project, "agent/2");
    expect(r.conversations).toBe(2);
    expect(instances[0]).toMatchObject({
      worktreeOn: true,
      workingDir: wt2,
      branch: "agent/2",
      worktreeOwned: false,
      lastSessionId: "s-newest",
    });
  });

  it("clears the last conversation when the worktree has none", async () => {
    conversations = {};
    await attachWorktree(instances[0], project, wt2);
    expect(instances[0].lastSessionId).toBeNull();
  });

  it("relaunches a running console in the worktree", async () => {
    consoles = [{ instanceId: "a", status: "running" }];
    await attachWorktree(instances[0], project, "agent/2");
    expect(calls).toEqual(["close a", `open a ${wt2}`]);
  });

  it("resumes the worktree's newest conversation instead of a fresh relaunch", async () => {
    consoles = [{ instanceId: "a", status: "running" }];
    const r = await attachWorktree(instances[0], project, "agent/2", { resume: true });
    expect(r.resumed).toBe("s-newest");
    expect(calls).toEqual([`resume a ${wt2} s-newest`]);
  });

  it("starts fresh when asked to resume a worktree with no conversations", async () => {
    conversations = {};
    consoles = [{ instanceId: "a", status: "running" }];
    const r = await attachWorktree(instances[0], project, "agent/2", { resume: true });
    expect(r.resumed).toBeNull();
    expect(calls).toEqual(["close a", `open a ${wt2}`]);
  });

  it("keeps a session that's already there as it was", async () => {
    instances = [inst("a", wt2, { worktreeOn: true, branch: "agent/2", lastSessionId: "s-mine" })];
    await attachWorktree(instances[0], project, "agent/2");
    expect(instances[0]).toMatchObject({ worktreeOwned: true, lastSessionId: "s-mine" });
  });

  it("refuses a worktree another running session works in, unless shared", async () => {
    instances = [...instances, inst("b", wt2.toLowerCase() + "\\", { title: "2" })];
    consoles = [{ instanceId: "b", status: "running" }];
    await expect(attachWorktree(instances[0], project, "agent/2")).rejects.toThrow(/in use by "2"/);
    expect(instances[0].workingDir).toBe(project.rootPath);
    await attachWorktree(instances[0], project, "agent/2", { share: true });
    expect(instances[0].workingDir).toBe(wt2);
  });

  it("doesn't count a stopped session in the worktree as a user", async () => {
    instances = [...instances, inst("b", wt2)];
    consoles = [{ instanceId: "b", status: "dormant" }];
    await attachWorktree(instances[0], project, "agent/2");
    expect(instances[0].workingDir).toBe(wt2);
  });

  it("refuses what isn't the project's worktree, and a remote project", async () => {
    await expect(attachWorktree(instances[0], project, "C:\\elsewhere")).rejects.toThrow("isn't a worktree");
    await expect(
      attachWorktree(instances[0], { ...project, remoteSshDest: "host" }, "agent/2"),
    ).rejects.toThrow("remote");
    expect(instances[0].workingDir).toBe(project.rootPath);
  });
});

describe("worktrees and their sessions", () => {
  it("lists the linked worktrees with who uses them", async () => {
    instances = [...instances, inst("b", wt2), inst("c", wt2)];
    consoles = [{ instanceId: "c", status: "spawning" }];
    const list = await projectWorktrees(project);
    expect(list.map((w) => w.path)).toEqual([wt2]);
    expect(list[0].sessions.map((i) => i.id)).toEqual(["b", "c"]);
    expect(list[0].live.map((i) => i.id)).toEqual(["c"]);
  });

  it("matches folders across separators and case", () => {
    const all = [inst("a", "C:/R/x/"), inst("b", "c:\\r\\x"), inst("c", "c:\\r\\y")];
    expect(sessionsInDir(all, "C:\\r\\x",{ exceptId: "b" }).map((i) => i.id)).toEqual(["a"]);
  });
});

describe("teardownWorktree", () => {
  it("never removes a worktree Workbench didn't make", async () => {
    const i = inst("a", wt2, { worktreeOn: true, worktreeOwned: false, branch: "agent/2" });
    await expect(teardownWorktree(i, project, { integrate: null, force: true })).rejects.toThrow("didn't make");
    expect(calls).not.toContain("remove");
  });
});
