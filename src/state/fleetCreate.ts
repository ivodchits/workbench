// A new session on another machine (fleet plan F9.2, decision 9): from
// `Ctrl+Alt+Shift+N` and a project row's button. With one other machine that has
// the project (the expected case) it goes straight there; with several, a small
// picker asks which. Offline machines can't be picked; none to send to is a toast.
//
// It sends that machine a `create` (the phone's step R7) for its own project id;
// the new card shows up under the machine's divider with its next snapshot.

import { useSyncExternalStore } from "react";
import { fleetViewAction } from "../ipc/fleet";
import type { RemoteCreateAction } from "../remote/protocol";
import { flash } from "../util/flash";
import type { FleetRail } from "./fleetRail";

/** A machine a session could start on, for a project. */
export interface CreateTarget {
  machine: string;
  name: string;
  online: boolean;
  /** Its project id. */
  projectId: string;
}

function requestId(): string {
  return `${Date.now().toString(36)}-${Math.floor(Math.random() * 2 ** 32).toString(36)}`;
}

/** The other machines with local project `projectId`, in the fleet's order. */
export function targetsFor(rail: FleetRail, projectId: string): CreateTarget[] {
  const online = new Map(rail.sections.map((s) => [s.machine, s.online]));
  return (rail.merged.get(projectId) ?? []).map((m) => ({
    machine: m.machine,
    name: m.machineName,
    online: online.get(m.machine) ?? false,
    projectId: m.projectId,
  }));
}

/** Send the `create` to `target`. */
export function createOn(target: Pick<CreateTarget, "machine" | "name" | "projectId">): void {
  const action: RemoteCreateAction = { type: "create", requestId: requestId(), projectId: target.projectId };
  fleetViewAction(target.machine, action).then(
    () => flash(`starting a session on ${target.name}…`),
    (e: unknown) => flash(`couldn’t start it on ${target.name}: ${String(e)}`),
  );
}

// --- the picker ---------------------------------------------------------------

let picking: { projectName: string; targets: CreateTarget[] } | null = null;
const listeners = new Set<() => void>();

function setPicking(next: typeof picking): void {
  picking = next;
  for (const l of listeners) l();
}

export function getCreatePicker(): typeof picking {
  return picking;
}

export function closeCreatePicker(): void {
  setPicking(null);
}

export function useCreatePicker(): typeof picking {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => picking,
  );
}

/** Start a session of local project `projectId` on the other machine. */
export function newSessionElsewhere(rail: FleetRail, projectId: string, projectName: string): void {
  const targets = targetsFor(rail, projectId);
  if (targets.length === 0) {
    const none = rail.sections.length === 0 ? "There's no other machine in the fleet." : `${projectName} isn't on the other machine.`;
    flash(none);
    return;
  }
  if (targets.length === 1) {
    const [t] = targets;
    if (!t.online) flash(`${t.name} is offline.`);
    else createOn(t);
    return;
  }
  if (!targets.some((t) => t.online)) {
    flash(`${targets.map((t) => t.name).join(" and ")} are offline.`);
    return;
  }
  setPicking({ projectName, targets });
}
