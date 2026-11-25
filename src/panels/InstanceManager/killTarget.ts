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
import type { MachineView } from "../../state/fleetView";
import type { RemoteInstance } from "../../remote/protocol";

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

// Another machine's session (fleet plan F9.4) is the target when it's what you're
// on: its rail card has keyboard focus, or its remote console tab is the active
// panel. `key` is `<machine>:<instance id>` (the card's `data-wb-remote-instance`,
// or the tab id without its `rconsole:` prefix); the machine is matched against
// the known ones rather than split on `:`, so an id with a colon still resolves.
// An SSH project's session is a tmux one on its host and can't be killed from here.


export type RemoteKillPick =
  | { kind: "target"; machine: string; inst: RemoteInstance }
  | { kind: "none"; reason: string };

export function pickRemoteKillTarget(
  key: string,
  views: ReadonlyMap<string, MachineView>,
  machineName: (machine: string) => string,
): RemoteKillPick {
  for (const [machine, view] of views) {
    if (!key.startsWith(`${machine}:`)) continue;
    const id = key.slice(machine.length + 1);
    const name = machineName(machine);
    const inst = view.snapshot?.instances.find((i) => i.id === id);
    if (!view.snapshot) return { kind: "none", reason: `${name} is offline — can't kill its session` };
    if (!inst) return { kind: "none", reason: `that session is gone from ${name}` };
    if (inst.remote) return { kind: "none", reason: `${inst.title} is an SSH session on its host — kill it there` };
    return { kind: "target", machine, inst };
  }
  return { kind: "none", reason: "that machine isn't in the fleet any more" };
}
