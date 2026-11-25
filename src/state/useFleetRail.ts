// The rail's and the office's view of the fleet (fleet plan F9.2, F9.3): this
// machine's projects matched with every other member's snapshot (`fleetRail`),
// recomputed as the registry, the remotes, the views or the members change.

import { useMemo } from "react";
import { getFleetStatus, useFleet } from "./fleet";
import { getFleetViews, useFleetViews, type MachineView } from "./fleetView";
import { gitRemoteOf, useGitRemotesVersion } from "./gitRemotes";
import { getRegistry, useRegistry } from "./registry";
import { fleetRail, type FleetRail, type PeerRef } from "./fleetRail";
import type { FleetStatus } from "../ipc/fleet";
import type { Project } from "../ipc/registry";

/** Why a member's view is down, for its dim line. */
export function offlineWhy(status: FleetStatus | null, view: MachineView | undefined, machine: string): string {
  const member = status?.members.find((m) => m.id === machine);
  if (!member?.online) return "offline";
  if (view?.error?.includes("remote access")) return "remote access off there";
  return "connecting…";
}

function compute(projects: readonly Project[], status: FleetStatus | null, views: ReadonlyMap<string, MachineView>): FleetRail {
  const peers: PeerRef[] = (status?.members ?? []).map((m) => {
    const v = views.get(m.id);
    return { machine: m.id, name: m.name, snapshot: v?.snapshot ?? null, lastProjects: v?.lastProjects ?? [] };
  });
  const locals = projects.map((p) => ({ id: p.id, name: p.name, gitRemote: gitRemoteOf(p) }));
  return fleetRail(locals, peers);
}

export function useFleetRail(): FleetRail {
  const { projects } = useRegistry();
  const status = useFleet();
  const views = useFleetViews();
  const remotes = useGitRemotesVersion();
  return useMemo(() => compute(projects, status, views), [projects, status, views, remotes]); // eslint-disable-line react-hooks/exhaustive-deps
}

/** The same, read now (for a once-registered command). */
export function getFleetRail(): FleetRail {
  return compute(getRegistry().projects, getFleetStatus(), getFleetViews());
}
