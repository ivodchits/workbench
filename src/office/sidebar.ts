// The sidebar's link section (office plan O0.2): where the office stands with
// Workbench, and what Duck is up to; the stats under it are stats.ts (O1.6). Below
// those, the room each project sits in (O1.3).

import type { RemoteDuck, RemoteInstance, RemoteProject } from "../remote/protocol";
import type { LinkState } from "./net";
import { TEAM_NAMES, type Team } from "./roster";

function duckLine(duck: RemoteDuck, instances: readonly RemoteInstance[]): HTMLParagraphElement {
  const p = document.createElement("p");
  const title = new Map(instances.map((i) => [i.id, i.title || i.taskNote || "untitled"]));
  const pilots = duck.autopilots.map((id) => title.get(id) ?? id);
  p.textContent = `Duck: ${duck.state}${pilots.length ? ` · autopilot on ${pilots.join(", ")}` : ""}`;
  return p;
}

export function showLink(el: HTMLElement, state: LinkState): void {
  const status = document.createElement("p");
  status.className = "muted";
  if (state.kind === "connecting") status.textContent = "Connecting to Workbench…";
  else if (state.kind === "offline") status.textContent = "Workbench can't be reached. Trying again…";
  else if (state.kind === "signedOut") status.textContent = "Open the office from Workbench (the status bar's “office”, or the palette).";
  if (state.kind !== "live") return el.replaceChildren(status);

  const { instances, duck } = state.snapshot;
  status.textContent = `${instances.filter((i) => i.live).length} live of ${instances.length} sessions`;
  el.replaceChildren(status, duckLine(duck, instances));
}

/** A room picker per project, rebuilt only when the projects or their rooms change (so
 *  an open picker survives snapshots). */
export function showRooms(el: HTMLElement, projects: readonly RemoteProject[], roomOf: (id: string) => Team, choose: (id: string, team: Team) => void): void {
  const key = JSON.stringify(projects.map((p) => [p.id, p.name, roomOf(p.id)]));
  if (el.dataset.key === key) return;
  el.dataset.key = key;
  if (!projects.length) return el.replaceChildren();

  const head = document.createElement("h2");
  head.textContent = "Rooms";
  const list = document.createElement("ul");
  list.className = "rooms";
  for (const p of projects) {
    const li = document.createElement("li");
    const label = document.createElement("label");
    label.textContent = p.name;
    const pick = document.createElement("select");
    for (const [team, name] of Object.entries(TEAM_NAMES)) pick.add(new Option(name, team, false, team === roomOf(p.id)));
    pick.addEventListener("change", () => choose(p.id, pick.value as Team));
    label.append(pick);
    li.append(label);
    list.append(li);
  }
  el.replaceChildren(head, list);
}
