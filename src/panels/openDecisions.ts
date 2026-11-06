// Opening a session's autopilot decisions log: a read-only tab beside its console.
// From the console header's "decisions" button, or from Duck
// (`show_autopilot_decisions`, through its port), which shows the session first.

import { setActiveProject } from "../state/activeProject";
import { openConsole } from "../state/consoles";
import { openPanelBeside, openPanelBesideWhenReady } from "../state/dock";
import { getRegistry } from "../state/registry";
import type { DecisionsPanelParams } from "./DecisionsPanel";

export const decisionsPanelId = (instanceId: string) => `decisions:${instanceId}`;

/** Open the log beside `instanceId`'s console, or bring its tab forward. With
 *  `show`, the session's project and console come up first. */
export function openDecisions(instanceId: string, opts: { show?: boolean } = {}): void {
  const instance = getRegistry().instances.find((i) => i.id === instanceId);
  if (!instance) return;
  const params: DecisionsPanelParams = { fromInstance: instanceId, title: instance.title };
  const panel = {
    id: decisionsPanelId(instanceId),
    component: "decisions",
    title: `decisions · ${instance.title}`,
    params: { ...params },
  };
  if (!opts.show) {
    openPanelBeside(instanceId, panel);
    return;
  }
  setActiveProject(instance.projectId);
  openConsole(instance);
  openPanelBesideWhenReady(instanceId, panel);
}
