// The in-process `WorkbenchPort` (step A2): Duck's view of the app, over the existing
// stores. The only file under `src/assistant/` that may import `src/state/**` or
// `src/panels/**` (ESLint enforces it).

import { getRegistry } from "../state/registry";
import { getLiveStatuses } from "../state/status";
import type { WorkbenchPort } from "./port";

export const localPort: WorkbenchPort = {
  listProjects() {
    return getRegistry().projects.map((p) => ({
      id: p.id,
      name: p.name,
      rootPath: p.rootPath,
    }));
  },
  listSessions(projectId) {
    const live = getLiveStatuses();
    return getRegistry()
      .instances.filter((i) => !projectId || i.projectId === projectId)
      .map((i) => ({
        id: i.id,
        projectId: i.projectId,
        title: i.title,
        taskNote: i.taskNote,
        phase: live.get(i.id)?.phase ?? "offline",
      }));
  },
};
