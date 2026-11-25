// Everyone on one floor (fleet plan F9.3, decision 8): the office server sends this
// machine's snapshot with the other machines' beside it (`fleet`), and this merges
// them into the one snapshot the office runs on.
//
// - A project on both machines (`fleetRail`'s matching: by git remote, else by
//   name) is one room and one team: the other machine's sessions take this
//   machine's project id.
// - A project only another machine has is a room of its own, while it has
//   sessions.
// - Another machine's session gets the id `m:<machine>:<instance>`, so two
//   machines' workers never collide, and carries `machine` and `machineName`.
//   Actions and transcripts for it are sent back to its machine by those
//   (`toMachine`, `net.ts`).

import type { RemoteInstance, RemoteProject, RemoteSnapshot } from "../remote/protocol";
import { fleetRail } from "../state/fleetRail";

/** What the office server adds to the snapshot when there are other machines. */
export interface OfficeFleet {
  /** This machine's name. */
  here: string;
  peers: { machine: string; name: string; snapshot: RemoteSnapshot }[];
}

export type OfficeFrame = RemoteSnapshot & { fleet?: OfficeFleet };

const PREFIX = "m:";

export function peerId(machine: string, id: string): string {
  return `${PREFIX}${machine}:${id}`;
}

/** An id from `peerId`, taken apart; null for this machine's own. */
export function parsePeerId(id: string): { machine: string; id: string } | null {
  if (!id.startsWith(PREFIX)) return null;
  const rest = id.slice(PREFIX.length);
  const at = rest.indexOf(":");
  return at > 0 ? { machine: rest.slice(0, at), id: rest.slice(at + 1) } : null;
}

export function mergeFleet(frame: OfficeFrame): RemoteSnapshot {
  const { fleet, ...local } = frame;
  if (!fleet || fleet.peers.length === 0) return local;
  const rail = fleetRail(
    local.projects.map((p) => ({ id: p.id, name: p.name, gitRemote: p.gitRemote })),
    fleet.peers.map((p) => ({ machine: p.machine, name: p.name, snapshot: p.snapshot })),
  );
  const names = new Map(local.projects.map((p) => [p.id, p.name]));
  const instances: RemoteInstance[] = local.instances.map((i) => ({ ...i, machineName: fleet.here }));
  const projects: RemoteProject[] = [...local.projects];
  const theirs = (i: RemoteInstance, machine: string, machineName: string, projectId: string, projectName: string): RemoteInstance => ({
    ...i,
    id: peerId(machine, i.id),
    projectId,
    projectName,
    machine,
    machineName,
    choice: i.choice,
  });
  for (const [localId, list] of rail.merged) {
    for (const m of list) {
      for (const i of m.instances) instances.push(theirs(i, m.machine, m.machineName, localId, names.get(localId) ?? i.projectName));
    }
  }
  for (const s of rail.sections) {
    for (const r of s.withSessions) {
      const id = peerId(s.machine, r.project.id);
      projects.push({ ...r.project, id });
      for (const i of r.instances) instances.push(theirs(i, s.machine, s.name, id, r.project.name));
    }
  }
  return { ...local, instances, projects };
}

/** An action for the office's socket: one for another machine's worker or project
 *  goes there with its own ids, and `machine` says where. */
export function toMachine<T extends { type: string }>(action: T): T & { machine?: string } {
  const a = action as T & { instanceId?: string; projectId?: string };
  const inst = typeof a.instanceId === "string" ? parsePeerId(a.instanceId) : null;
  if (inst) return { ...action, instanceId: inst.id, machine: inst.machine };
  const proj = a.type === "create" && typeof a.projectId === "string" ? parsePeerId(a.projectId) : null;
  if (proj) return { ...action, projectId: proj.id, machine: proj.machine };
  return action;
}

/** A transcript socket's query, likewise. */
export function transcriptParams(params: Record<string, string>): Record<string, string> {
  const inst = params.instance ? parsePeerId(params.instance) : null;
  return inst ? { ...params, instance: inst.id, machine: inst.machine } : params;
}
