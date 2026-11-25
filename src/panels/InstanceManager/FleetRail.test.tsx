// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../ipc/fleet", () => ({ fleetViewAction: () => Promise.resolve() }));

import type { RemoteInstance, RemoteProject } from "../../remote/protocol";
import type { MachineSection } from "../../state/fleetRail";
import { FleetSection, MachineDivider } from "./FleetRail";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function project(id: string, name: string): RemoteProject {
  return { id, name, group: null, remote: false, lastCommitAt: null, commitsToday: null, gitRemote: null };
}
function instance(id: string, projectId: string, phase: RemoteInstance["phase"]): RemoteInstance {
  return {
    id,
    projectId,
    projectName: "",
    title: `session ${id}`,
    taskNote: "",
    branch: "main",
    worktreeOn: false,
    remote: false,
    phase,
    compacting: false,
    subagents: 0,
    activity: null,
    status: "idle",
    ctxTokens: 0,
    live: phase !== null,
    needsSince: null,
    escalated: false,
    stuck: false,
    choice: null,
  };
}

let host: HTMLDivElement | null = null;
function render(node: React.ReactNode): HTMLDivElement {
  host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  act(() => root.render(node));
  return host;
}
afterEach(() => {
  host?.remove();
  host = null;
  localStorage.clear();
});

describe("the rail's other machines", () => {
  const laptop: MachineSection = {
    machine: "L",
    name: "laptop",
    online: true,
    withSessions: [{ machine: "L", project: project("p", "solo"), instances: [instance("a", "p", "needs_you")] }],
    noSessions: [{ machine: "L", project: project("q", "empty"), instances: [] }],
  };

  it("shows the band, the machine, its projects, and a folded no-sessions group", () => {
    const el = render(<FleetSection sections={[laptop]} needsYouOnly={false} whyOffline={() => "offline"} />);
    const text = el.textContent ?? "";
    expect(text).toContain("OTHER MACHINES");
    expect(text).toContain("laptop");
    expect(text).toContain("solo");
    expect(text).toContain("session a");
    expect(text).toContain("needs you");
    expect(text).toContain("no sessions");
    expect(text).not.toContain("empty"); // folded
    const fold = [...el.querySelectorAll("button")].find((b) => b.textContent?.includes("no sessions"))!;
    act(() => fold.click());
    expect(el.textContent).toContain("empty");
  });

  it("is one dim line for a machine that's gone", () => {
    const gone: MachineSection = { machine: "L", name: "laptop", online: false, withSessions: [], noSessions: [] };
    const el = render(<FleetSection sections={[gone]} needsYouOnly={false} whyOffline={() => "offline"} />);
    expect(el.textContent).toContain("laptop · offline");
    const divider = render(<MachineDivider name="laptop" offline="offline" />);
    expect(divider.textContent).toContain("laptop · offline");
  });
});
