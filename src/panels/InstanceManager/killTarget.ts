// Which instance Ctrl+Shift+K ("kill the focused instance") may offer to kill.
//
// The consoles store's active id is global: switching projects keeps the other
// project's consoles running in the background, and when the newly selected
// project's dock has no console to activate, the active id still points at a
// console from the project you just left. Reading it unchecked offered (and,
// once confirmed, killed) sessions of a project that wasn't on screen. So the
// target must belong to the selected project — with no selected project, or no
// focused console in it, there is nothing to kill, and we never fall back to
// some other session.

import type { Instance } from "../../ipc/registry";

export type KillPick =
  | { kind: "target"; instance: Instance }
  | { kind: "none"; reason: string };

export function pickKillTarget(
  instances: readonly Instance[],
  activeProjectId: string | null,
  activeConsoleId: string | null,
  projectName?: string,
): KillPick {
  if (!activeProjectId) return { kind: "none", reason: "no project selected — nothing to kill" };
  const where = projectName ? ` in ${projectName}` : " in this project";
  const inst = activeConsoleId ? instances.find((i) => i.id === activeConsoleId) : undefined;
  if (!inst || inst.projectId !== activeProjectId) {
    return { kind: "none", reason: `no focused session${where} — nothing to kill` };
  }
  return { kind: "target", instance: inst };
}
