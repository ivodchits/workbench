// The sidebar's link section (office plan O0.2): where the office stands with
// Workbench and, until workers come to life in O1, the live instance list as plain text.

import type { RemoteInstance } from "../remote/protocol";
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
  const extra = [phase ?? "not running", i.compacting && "compacting", i.subagents > 0 && `${i.subagents} subagents`].filter(Boolean);
  text.textContent = `${i.projectName} · ${what} — ${extra.join(", ")}`;
  li.append(glyph, text);
  return li;
}

export function showLink(el: HTMLElement, state: LinkState): void {
  const status = document.createElement("p");
  status.className = "muted";
  if (state.kind === "connecting") status.textContent = "Connecting to Workbench…";
  else if (state.kind === "offline") status.textContent = "Workbench can't be reached. Trying again…";
  else if (state.kind === "signedOut") status.textContent = "Open the office from Workbench (the status bar's “office”, or the palette).";
  if (state.kind !== "live") return el.replaceChildren(status);

  const { instances } = state.snapshot;
  const live = instances.filter((i) => i.live);
  status.textContent = `${live.length} live of ${instances.length} sessions`;
  const list = document.createElement("ul");
  list.className = "instances";
  // Live ones first, in the rail's order otherwise.
  list.append(...[...live, ...instances.filter((i) => !i.live)].map(line));
  el.replaceChildren(status, list);
}
