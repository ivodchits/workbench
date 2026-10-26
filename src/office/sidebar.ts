// The sidebar's link section (office plan O0.2): where the office stands with
// Workbench and, until workers come to life in O1, Duck and the live instance list as
// plain text.

import type { RemoteDuck, RemoteInstance } from "../remote/protocol";
import type { LinkState } from "./net";

/** The rail's glyphs. */
const GLYPH: Record<string, string> = { working: "◐", needs_you: "●", done: "○", idle: "·", ended: "–" };

function line(i: RemoteInstance): HTMLLIElement {
  const li = document.createElement("li");
  const phase = i.phase ?? (i.live ? "idle" : null);
  li.className = phase ? `phase-${phase}` : "off";
  const glyph = document.createElement("span");
  glyph.className = "glyph";
  glyph.textContent = phase ? GLYPH[phase] : " ";
  const text = document.createElement("span");
  const what = i.title || i.taskNote || "untitled";
  const doing = phase === "working" && i.activity ? `working: ${i.activity}` : phase;
  const extra = [doing ?? "not running", i.compacting && "compacting", i.subagents > 0 && `${i.subagents} subagents`].filter(Boolean);
  text.textContent = `${i.projectName} · ${what} — ${extra.join(", ")}`;
  li.append(glyph, text);
  return li;
}

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
  const live = instances.filter((i) => i.live);
  status.textContent = `${live.length} live of ${instances.length} sessions`;
  const list = document.createElement("ul");
  list.className = "instances";
  // Live ones first, in the rail's order otherwise.
  list.append(...[...live, ...instances.filter((i) => !i.live)].map(line));
  el.replaceChildren(status, duckLine(duck, instances), list);
}
