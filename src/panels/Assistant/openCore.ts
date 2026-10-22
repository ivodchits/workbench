// Opening Duck's files in the editor, in the workspace's project ("Duck", the one
// the worker tasks use): the core memory (step W4), `memory/core.md`, made with its
// four empty sections when there is none yet; a skill (step S2). Only ever called
// from a click.

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

/** A file in Duck's workspace (an absolute path), such as a skill's SKILL.md. */
export async function openDuckFile(workspace: string | null, path: string): Promise<void> {
  const dir = await workspacePrepare(workspace);
  const p = await localPort.ensureProject("Duck", dir);
  setActiveProject(p.id);
  openProjectFile({ projectId: p.id, rootPath: p.rootPath, label: p.name }, { path });
}
