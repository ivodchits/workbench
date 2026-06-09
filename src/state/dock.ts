// Dock control (step 1.10) — a module-level handle on the app's single dockview
// `DockviewApi`, so the keyboard layer can drive panel navigation/layout without
// prop-drilling the api out of `Workspace`. There is exactly one `DockviewReact`
// for the whole app (the per-project tree is *swapped* into it, decision 13 / §5),
// so one ref suffices. `Workspace` sets it on ready and clears it on unmount.
//
// "Focusing a panel" means more than activating its dockview group: for a console
// we also hand DOM focus to its pooled xterm terminal, so the keyboard lands in
// the live `claude` TUI rather than nowhere.

import type { DockviewApi, IDockviewPanel } from "dockview";
import { focusTerminal } from "../panels/terminalPool";

let api: DockviewApi | null = null;

/** Register (or clear) the app's dockview api. Called by `Workspace.onReady`. */
export function setDockApi(a: DockviewApi | null): void {
  api = a;
}

/**
 * Activate a panel's group and route DOM focus into its content. Activating alone
 * only brings the tab to front — it does *not* move the keyboard out of whatever
 * is currently focused (the source console's xterm, the editor's CodeMirror) — so
 * we focus the target's content explicitly, by panel type:
 *
 *   • console / shell — the panel id is the terminal-pool key (Workspace adds them
 *     as `id: instanceId` / `id: shellId`, and both host via `Console`), so
 *     `focusTerminal(panel.id)` focuses the live xterm. (A `params.instanceId`
 *     lookup misses shells, whose param is `shellId` — that was the focus bug.)
 *   • editor — owns no pooled terminal; we focus its CodeMirror content directly
 *     (tagged with `data-wb-panel={editorId}` in the Editor panel).
 *
 * Each step is a no-op for the other panel types, so the right one wins.
 */
function focusContent(panel: IDockviewPanel): void {
  panel.api.setActive();
  focusTerminal(panel.id); // console + shell (pool keyed by panel id)
  document
    .querySelector<HTMLElement>(`[data-wb-panel="${panel.id}"] .cm-content`)
    ?.focus(); // editor (no-op when the panel isn't an editor)
}

/** Move focus to the next (`+1`) or previous (`-1`) panel, wrapping around. */
export function cyclePanel(delta: 1 | -1): void {
  if (!api) return;
  const panels = api.panels;
  if (panels.length === 0) return;
  const active = api.activePanel;
  const idx = active ? panels.findIndex((p) => p.id === active.id) : -1;
  const next = panels[(idx + delta + panels.length) % panels.length] ?? panels[0];
  if (next) focusContent(next);
}

/** Focus the panel at 1-based position `n` (no-op if there are fewer panels). */
export function focusPanelIndex(n: number): void {
  if (!api) return;
  const panel = api.panels[n - 1];
  if (panel) focusContent(panel);
}

/**
 * Split the focused panel out into its own column to the right — the same
 * primitive the group header's "◨" button uses (Workspace `HeaderActions`). A
 * console can't be split into two live views before the PTY multiplexer (Phase 4),
 * so "split" here means "arrange this panel side-by-side", which is the useful,
 * non-destructive gesture available now.
 */
export function splitActivePanel(): void {
  if (!api) return;
  const panel = api.activePanel;
  if (!panel) return;
  const group = api.addGroup({ direction: "right" });
  panel.api.moveTo({ group, position: "center" });
  focusContent(panel);
}

/** Close the focused panel (its console/shell/editor teardown runs via Workspace). */
export function closeActivePanel(): void {
  if (!api) return;
  const panel = api.activePanel;
  if (panel) api.removePanel(panel);
}

/** Return DOM focus to the active panel's content (e.g. leaving the rail). */
export function focusActivePanel(): void {
  if (!api) return;
  const panel = api.activePanel;
  if (panel) focusContent(panel);
}
