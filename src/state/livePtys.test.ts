// A page reload (Duck taking over from a machine that went off, the renderer
// watchdog) leaves the backend's PTYs running. The restored consoles and shells
// must come back running — attaching to them — not dormant, whose relaunch
// would kill the live session.

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Instance } from "../ipc/registry";
import type { LivePty } from "../ipc/pty";

vi.mock("../panels/terminalPool", () => ({ release: vi.fn() }));
vi.mock("./registry", () => ({
  getRegistry: () => ({ projects: [{ id: "p2", remoteSshDest: "box", remoteDir: "/w" }], instances }),
  applyInstanceUsage: vi.fn(),
  updateInstance: vi.fn(async () => {}),
}));

const instances = [
  { id: "a", projectId: "p1", workingDir: "C:/a", lastSessionId: null },
  { id: "r", projectId: "p2", workingDir: "/w", lastSessionId: null, remoteTmuxSession: "t" },
] as unknown as Instance[];

const live: LivePty[] = [
  { id: "a", kind: "claude", cwd: "C:/a", sessionId: "s-a" },
  { id: "r", kind: "claude", cwd: "C:/home", sessionId: null },
  { id: "sh", kind: "shell", cwd: "C:/a", sessionId: null },
  { id: "t", kind: "task", cwd: "C:/a", sessionId: null },
];

let consoles: typeof import("./consoles");
let shells: typeof import("./shells");

beforeEach(async () => {
  vi.resetModules();
  consoles = await import("./consoles");
  shells = await import("./shells");
});

describe("adoptLiveConsoles", () => {
  it("brings every live claude back running, over a dormant placeholder too", () => {
    consoles.hydrateDormant(["a", "gone"]);
    consoles.adoptLiveConsoles(live);
    const open = consoles.getOpenConsoles();
    expect(open.map((c) => [c.instanceId, c.status])).toEqual([
      ["a", "running"],
      ["gone", "dormant"],
      ["r", "running"],
    ]);
    expect(open[0]).toMatchObject({ cwd: "C:/a", sessionId: "s-a", remote: null });
    expect(open[2].remote).toEqual({ dest: "box", session: "t", dir: "/w" });
    // The layout's restore after it leaves them be.
    consoles.hydrateDormant(["a", "r"]);
    expect(consoles.getOpenConsoles().filter((c) => c.status === "running")).toHaveLength(2);
  });

  it("leaves a console already running here alone", () => {
    consoles.openConsole(instances[0]);
    consoles.adoptLiveConsoles(live);
    const a = consoles.getOpenConsoles().find((c) => c.instanceId === "a");
    expect(a?.status).toBe("spawning");
  });
});

describe("hydrateShells", () => {
  it("restores a live shell running, the rest dormant", () => {
    shells.hydrateShells(
      [
        { shellId: "sh", projectId: "p1", cwd: "C:/old", label: "p1" },
        { shellId: "x", projectId: "p1", cwd: "C:/a", label: "p1" },
      ],
      live,
    );
    expect(shells.getOpenShells().map((s) => [s.shellId, s.status, s.cwd])).toEqual([
      ["sh", "running", "C:/a"],
      ["x", "dormant", "C:/a"],
    ]);
  });
});
