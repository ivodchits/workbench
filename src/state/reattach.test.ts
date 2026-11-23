// After a page reload the PTYs are still running in the backend: restored
// placeholders whose PTY is live attach to it rather than stay dormant.
import { describe, expect, it, vi } from "vitest";

const live = [
  { instanceId: "a", sessionId: "sess-a", cwd: "C:/proj" },
  { instanceId: "shell-1", sessionId: null, cwd: "C:/proj" },
];

vi.mock("../ipc/pty", () => ({ ptyLiveList: vi.fn(async () => live) }));
vi.mock("../panels/terminalPool", () => ({ release: vi.fn() }));
vi.mock("./registry", () => ({
  getRegistry: () => ({ instances: [], projects: [] }),
  applyInstanceUsage: vi.fn(),
  updateInstance: vi.fn(),
}));
vi.mock("./status", () => ({ clearLiveStatus: vi.fn() }));
vi.mock("./queue", () => ({ cancelQueued: vi.fn() }));
vi.mock("./headlessFlag", () => ({ isHeadless: () => false }));

import { getOpenConsoles, hydrateDormant } from "./consoles";
import { getOpenShells, hydrateShells } from "./shells";

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("reattaching after a reload", () => {
  it("brings consoles with a live PTY back running, leaves the rest dormant", async () => {
    hydrateDormant(["a", "b"]);
    await flush();
    const byId = Object.fromEntries(getOpenConsoles().map((c) => [c.instanceId, c]));
    expect(byId.a).toMatchObject({ status: "running", sessionId: "sess-a", cwd: "C:/proj", kind: "claude" });
    expect(byId.b.status).toBe("dormant");
  });

  it("does the same for shells", async () => {
    hydrateShells([
      { shellId: "shell-1", projectId: "p", cwd: "C:/proj", label: "p" },
      { shellId: "shell-2", projectId: "p", cwd: "C:/proj", label: "p" },
    ]);
    await flush();
    const byId = Object.fromEntries(getOpenShells().map((s) => [s.shellId, s]));
    expect(byId["shell-1"].status).toBe("running");
    expect(byId["shell-2"].status).toBe("dormant");
  });
});
