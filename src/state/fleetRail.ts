// Matching the fleet's projects (fleet plan F9.1, decisions 1–4): this machine's
// projects and the other machines' snapshots in; for each of this machine's
// projects, the other machines' sessions in it; and per other machine, the
// projects only it has, those with sessions apart from those without.
//
// Which projects are "the same": by git remote when both sides know theirs (the
// same repo under another folder name matches; the same name with another remote
// doesn't), else by name. A pure function: the rail and the office both use it.

import type { RemoteInstance, RemoteProject, RemoteSnapshot } from "../remote/protocol";

export interface LocalProjectRef {
  id: string;
  name: string;
  /** Normalized; null for none, undefined while unknown. */
  gitRemote?: string | null;
}

export interface PeerRef {
  machine: string;
  name: string;
  /** Its view is live (a snapshot); else its lines read `offline`. */
  snapshot: RemoteSnapshot | null;
  /** Its projects when it was last seen, so an offline machine's divider stays in
   *  the projects it had. */
  lastProjects?: readonly RemoteProject[];
}

/** One other machine's sessions in a project this machine has too. */
export interface MachineSessions {
  machine: string;
  machineName: string;
  /** Its project (the first, when several of its projects match). */
  projectId: string;
  instances: RemoteInstance[];
}

/** A project only another machine has. */
export interface RemoteOnly {
  machine: string;
  project: RemoteProject;
  instances: RemoteInstance[];
}

export interface MachineSection {
  machine: string;
  name: string;
  online: boolean;
  /** Its own projects with sessions, by name. */
  withSessions: RemoteOnly[];
  /** And without (the folded `No sessions` group), by name. */
  noSessions: RemoteOnly[];
}

export interface FleetRail {
  /** This machine's project id → the other machines with it, in `peers` order
   *  (offline ones too, with no sessions, so the divider can say so). */
  merged: Map<string, MachineSessions[]>;
  sections: MachineSection[];
}

/** Whether `local` and `remote` are the same project. */
export function sameProject(local: LocalProjectRef, remote: RemoteProject): boolean {
  if (local.gitRemote && remote.gitRemote) return local.gitRemote === remote.gitRemote;
  return local.name.trim().toLowerCase() === remote.name.trim().toLowerCase();
}

/** The local project a remote one is matched to: a remote match first, then a name
 *  match among those not ruled out by a different remote. */
function matchOf(locals: readonly LocalProjectRef[], remote: RemoteProject): LocalProjectRef | null {
  if (remote.gitRemote) {
    const byRemote = locals.find((l) => l.gitRemote === remote.gitRemote);
    if (byRemote) return byRemote;
  }
  return locals.find((l) => sameProject(l, remote)) ?? null;
}

const byName = (a: RemoteOnly, b: RemoteOnly) =>
  a.project.name.localeCompare(b.project.name, undefined, { sensitivity: "base" });

export function fleetRail(locals: readonly LocalProjectRef[], peers: readonly PeerRef[]): FleetRail {
  const merged = new Map<string, MachineSessions[]>();
  const sections: MachineSection[] = [];
  for (const peer of peers) {
    const snap = peer.snapshot;
    const section: MachineSection = {
      machine: peer.machine,
      name: peer.name,
      online: snap !== null,
      withSessions: [],
      noSessions: [],
    };
    sections.push(section);
    const projects = snap?.projects ?? peer.lastProjects ?? [];
    const byProject = new Map<string, RemoteInstance[]>();
    for (const i of snap?.instances ?? []) {
      const list = byProject.get(i.projectId);
      if (list) list.push(i);
      else byProject.set(i.projectId, [i]);
    }
    const mine = new Map<string, MachineSessions>();
    for (const p of projects) {
      const instances = byProject.get(p.id) ?? [];
      const local = matchOf(locals, p);
      if (!local) {
        if (!snap) continue; // an offline machine's own projects aren't listed
        (instances.length ? section.withSessions : section.noSessions).push({ machine: peer.machine, project: p, instances });
        continue;
      }
      const had = mine.get(local.id);
      if (had) {
        had.instances.push(...instances);
        continue;
      }
      const entry: MachineSessions = { machine: peer.machine, machineName: peer.name, projectId: p.id, instances: [...instances] };
      mine.set(local.id, entry);
      const list = merged.get(local.id);
      if (list) list.push(entry);
      else merged.set(local.id, [entry]);
    }
    section.withSessions.sort(byName);
    section.noSessions.sort(byName);
  }
  return { merged, sections };
}
