// Opening Duck's core memory (step W4) in the editor: `memory/core.md` in the
// workspace's project ("Duck", the one the worker tasks use), made with its four
// empty sections when there is none yet. Only ever called from a click.

import { EMPTY_CORE } from "../../assistant/core";
import { localPort } from "../../assistant/port.local";
import { coreRead, coreWrite, workspacePrepare } from "../../ipc/assistant";
import { setActiveProject } from "../../state/activeProject";
import { openProjectFile } from "../../state/editors";

export async function openCoreMemory(workspace: string | null): Promise<void> {
  const dir = await workspacePrepare(workspace);
  const [path, text] = await coreRead(dir);
  if (text === null) await coreWrite(dir, EMPTY_CORE, null);
  const p = await localPort.ensureProject("Duck", dir);
  setActiveProject(p.id);
  openProjectFile({ projectId: p.id, rootPath: p.rootPath, label: p.name }, { path });
}
