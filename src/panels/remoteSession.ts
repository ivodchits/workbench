// Opening and driving another machine's session (fleet plan F9.2): the remote
// console tab's id and how it's opened, the action sender, and the session's state
// from the fleet view. Shared by the rail's remote cards and the tab itself.

import { GLYPH } from "../theme";
import { fleetViewAction } from "../ipc/fleet";
import type { RemoteAction, RemoteInstance } from "../remote/protocol";
import { getActiveProject, setActiveProject } from "../state/activeProject";
import { getDisplayedProject, openPanelInProject } from "../state/dock";
import { useFleet } from "../state/fleet";
import { useFleetViews } from "../state/fleetView";
import { flash } from "../util/flash";

/** A remote console tab's binding. */
export interface RemoteConsoleParams {
  /** The machine's fleet id. */
  machine: string;
  /** Its instance id there. Not `instanceId`: the workspace takes a panel with
   *  that param for a local console. */
  remoteInstance: string;
  title: string;
}

/** Every remote console tab id starts with this. */
export const REMOTE_CONSOLE_PREFIX = "rconsole:";
export const remoteConsolePanelId = (machine: string, instance: string) => `${REMOTE_CONSOLE_PREFIX}${machine}:${instance}`;

/** Send an action to the session's machine; a failure is flashed. */
export function sendRemote(machine: string, action: RemoteAction): void {
  fleetViewAction(machine, action).catch((e: unknown) => flash(`couldn’t reach that machine: ${String(e)}`));
}

/** The machine's name, from the fleet status. */
export function useMachineName(machine: string): string {
  const fleet = useFleet();
  return fleet?.members.find((m) => m.id === machine)?.name ?? "the other machine";
}

/** The session as the machine's latest snapshot has it; null when it's gone or the
 *  machine is offline (`online` says which). */
export function useRemoteInstance(machine: string, instance: string): { inst: RemoteInstance | null; online: boolean } {
  const views = useFleetViews();
  const snap = views.get(machine)?.snapshot ?? null;
  return { inst: snap?.instances.find((i) => i.id === instance) ?? null, online: snap !== null };
}

/** The dot a remote session shows, from its snapshot. */
export function remoteStatus(i: RemoteInstance): { glyph: string; colorVar: string; label: string; spinning: boolean; needsYou: boolean; done: boolean } {
  const base = { spinning: false, needsYou: false, done: false };
  if (i.compacting) return { ...base, glyph: "◐", colorVar: "var(--wb-working)", label: "compacting…", spinning: true };
  switch (i.phase) {
    case "working":
      return { ...base, glyph: "◐", colorVar: "var(--wb-working)", label: "working", spinning: true };
    case "needs_you":
      return { ...base, glyph: "●", colorVar: "var(--wb-needs)", label: "needs you", needsYou: true };
    case "done":
      return { ...base, glyph: "○", colorVar: "var(--wb-done)", label: "done", done: true };
    case "idle":
      return { ...base, glyph: "○", colorVar: "var(--wb-done)", label: "idle" };
  }
  if (i.live) return { ...base, glyph: GLYPH.run, colorVar: "var(--wb-accent)", label: "running" };
  return { ...base, glyph: "−", colorVar: "var(--wb-closed)", label: "closed" };
}

/** Open a remote session's tab: in local project `inProject`'s workspace when it's
 *  a merged project, else in whatever workspace is on screen. */
export function openRemoteConsole(machine: string, inst: Pick<RemoteInstance, "id" | "title">, inProject: string | null): void {
  const params: RemoteConsoleParams = { machine, remoteInstance: inst.id, title: inst.title };
  const panel = { id: remoteConsolePanelId(machine, inst.id), component: "remoteConsole", title: inst.title, params: { ...params } };
  const project = inProject ?? getDisplayedProject() ?? getActiveProject();
  if (!project) {
    flash("Open one of this machine's projects first: the session's tab opens in its workspace.");
    return;
  }
  if (inProject) setActiveProject(inProject);
  openPanelInProject(project, panel);
}

